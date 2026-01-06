/**
 * Cloudflare Worker - IMDb Ratings Proxy with D1 Cache & Smart TTL
 * Optimized for Batched Subrequests
 */

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};

const OMDB_BASE_URL = 'https://www.omdbapi.com';

const TTL = {
    RECENT: 60 * 60 * 1000,           // 1 hour
    MEDIUM: 24 * 60 * 60 * 1000,      // 1 day
    STABLE: 30 * 24 * 60 * 60 * 1000  // 30 days
};

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        if (request.method !== 'POST') {
            return jsonResponse({ error: 'Method not allowed' }, 405);
        }

        const url = new URL(request.url);
        if (!url.pathname.endsWith('/batch')) {
            return jsonResponse({ error: 'Not found' }, 404);
        }

        try {
            const body = await request.json();
            const { movies } = body;

            if (!movies || !Array.isArray(movies)) {
                return jsonResponse({ error: 'Invalid payload' }, 400);
            }

            // 1. Batch D1 Lookup
            const hrefs = [...new Set(movies.map(m => m.href).filter(Boolean))];
            let cachedMap = new Map();

            if (hrefs.length > 0) {
                const placeholders = hrefs.map(() => '?').join(',');
                const cachedRows = await env.DB.prepare(`SELECT * FROM movies WHERE prime_href IN (${placeholders})`)
                    .bind(...hrefs)
                    .all();

                if (cachedRows.results) {
                    cachedRows.results.forEach(row => {
                        cachedMap.set(row.prime_href, row);
                    });
                }
            }

            // 2. Process movies (Cache check -> OMDb fetch if needed)
            const updates = [];
            const results = await Promise.all(
                movies.map(async (movie) => {
                    const cached = cachedMap.get(movie.href);
                    const result = await processMovieLogic(movie, cached, env);

                    if (result.source === 'api' && result.data) {
                        updates.push(result.data);
                    }
                    return result;
                })
            );

            // 3. Batch D1 Saves
            if (updates.length > 0) {
                const statements = updates.map(data => {
                    return env.DB.prepare(`
                        INSERT INTO movies (imdb_id, title, year, release_date, prime_href, rating, votes, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(prime_href) DO UPDATE SET
                            imdb_id = excluded.imdb_id,
                            rating = excluded.rating,
                            votes = excluded.votes,
                            updated_at = excluded.updated_at
                    `).bind(
                        data.imdb_id,
                        data.title,
                        data.year,
                        data.release_date,
                        data.prime_href,
                        data.rating,
                        data.votes,
                        data.updated_at
                    );
                });
                await env.DB.batch(statements);
            }

            return jsonResponse({ results });
        } catch (error) {
            console.error('Worker error:', error);
            return jsonResponse({ error: 'Internal server error', details: error.message }, 500);
        }
    }
};

async function processMovieLogic(movie, cached, env) {
    let { title, href } = movie;
    if (!href) return { href, error: 'Missing href' };

    if (cached) {
        if (!isDataStale(cached.release_date, cached.updated_at)) {
            return { href, data: cached, source: 'cache' };
        }
        if (!title) return { href, data: cached, source: 'cache-stale' };
    }

    if (!title) {
        return { href, error: 'OMDb Lookup skipped: Missing title' };
    }

    const directorsCutRegex = /\s*Director's Cut$/i;
    if (directorsCutRegex.test(title) && title.replace(directorsCutRegex, '').trim().length > 0) {
        title = title.replace(directorsCutRegex, '').trim();
    }

    try {
        let omdbResult = await fetchOMDb(title, null, env.OMDB_API_KEY);

        if (!omdbResult) {
            if (title.includes('&')) {
                const alt = title.replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
                omdbResult = await fetchOMDb(alt, null, env.OMDB_API_KEY);
            }
        }

        if (!omdbResult) {
            const alt = title.replace(/\s*\([^)]*\)\s*$/, '').trim();
            if (alt !== title) omdbResult = await fetchOMDb(alt, null, env.OMDB_API_KEY);
        }

        if (!omdbResult) return { href, error: 'OMDb Not Found' };

        const movieData = {
            imdb_id: omdbResult.imdbID,
            title: title,
            year: parseInt(omdbResult.Year) || 0,
            release_date: parseReleaseDate(omdbResult.Released),
            prime_href: href,
            rating: parseFloat(omdbResult.imdbRating) || 0,
            votes: parseInt((omdbResult.imdbVotes || '0').replace(/,/g, '')) || 0,
            updated_at: new Date().toISOString()
        };

        return { href, data: movieData, source: 'api' };
    } catch (e) {
        return { href, error: e.message };
    }
}

function isDataStale(releaseDateStr, updatedAtStr) {
    if (!releaseDateStr) return true;
    const now = Date.now();
    const lastUpdate = new Date(updatedAtStr).getTime();
    const release = new Date(releaseDateStr).getTime();
    if (isNaN(lastUpdate) || isNaN(release)) return true;
    const daysSinceRelease = (now - release) / (1000 * 60 * 60 * 24);
    const timeSinceUpdate = now - lastUpdate;
    if (daysSinceRelease <= 7) return timeSinceUpdate > TTL.RECENT;
    if (daysSinceRelease <= 14) return timeSinceUpdate > TTL.MEDIUM;
    return timeSinceUpdate > TTL.STABLE;
}

async function fetchOMDb(title, year, apiKey) {
    const params = new URLSearchParams({ apikey: apiKey, t: title });
    if (year) params.append('y', year);
    const res = await fetch(`${OMDB_BASE_URL}/?${params}`);
    const data = await res.json();
    return data.Response === 'True' ? data : null;
}

function parseReleaseDate(dateStr) {
    if (!dateStr || dateStr === 'N/A') return new Date().toISOString();
    return new Date(dateStr).toISOString();
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}
