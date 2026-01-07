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
    let { title, href, entityType } = movie;
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

    // Pre-processing 1: Remove Director's Cut suffix
    const directorsCutRegex = /\s*Director's Cut$/i;
    if (directorsCutRegex.test(title) && title.replace(directorsCutRegex, '').trim().length > 0) {
        title = title.replace(directorsCutRegex, '').trim();
    }

    // Pre-processing 2: Remove trailing (...) or [...] - PERMANENTLY UPDATE TITLE
    title = title.replace(/\s*(?:\([^)]*\)|\[[^\]]*\])\s*$/, '').trim() || title;

    try {
        let omdbResult = null;

        // Step 1: Try title lookup with cleaned title
        omdbResult = await fetchOMDbTitle(title, null, env.OMDB_API_KEY);

        // Validate result: type must match AND rating must not be N/A
        if (omdbResult && !isValidResult(omdbResult, entityType)) {
            omdbResult = null;
        }

        // Step 2: If failed, try replacing & with 'and'
        if (!omdbResult && title.includes('&')) {
            const altTitle = title.replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
            omdbResult = await fetchOMDbTitle(altTitle, null, env.OMDB_API_KEY);

            if (omdbResult && !isValidResult(omdbResult, entityType)) {
                omdbResult = null;
            }
        }

        // Step 3: Final fallback - OMDb search API using original cleaned title (without & replacement)
        if (!omdbResult) {
            omdbResult = await fetchOMDbSearch(title, env.OMDB_API_KEY);
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

/**
 * Validate OMDb result: type must match Prime entity type AND rating must not be N/A
 */
function isValidResult(omdbResult, primeEntityType) {
    // Check rating - must not be N/A
    if (!omdbResult.imdbRating || omdbResult.imdbRating === 'N/A') {
        return false;
    }

    // Check type match if we have Prime entity type
    if (primeEntityType) {
        const omdbType = omdbResult.Type?.toLowerCase();
        // Prime: "Movie" -> OMDb: "movie"
        // Prime: "TV Show" -> OMDb: "series"
        const expectedOmdbType = primeEntityType === 'Movie' ? 'movie' : 'series';
        if (omdbType !== expectedOmdbType) {
            return false;
        }
    }

    return true;
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

/**
 * OMDb Title Lookup (exact match)
 */
async function fetchOMDbTitle(title, year, apiKey) {
    const params = new URLSearchParams({ apikey: apiKey, t: title });
    if (year) params.append('y', year);
    const res = await fetch(`${OMDB_BASE_URL}/?${params}`);
    const data = await res.json();
    return data.Response === 'True' ? data : null;
}

/**
 * OMDb Search API - returns first result with full details
 */
async function fetchOMDbSearch(title, apiKey) {
    const params = new URLSearchParams({ apikey: apiKey, s: title });
    const res = await fetch(`${OMDB_BASE_URL}/?${params}`);
    const data = await res.json();

    if (data.Response !== 'True' || !data.Search || data.Search.length === 0) {
        return null;
    }

    // Get the first result's IMDb ID and fetch full details
    const firstResult = data.Search[0];
    const detailParams = new URLSearchParams({ apikey: apiKey, i: firstResult.imdbID });
    const detailRes = await fetch(`${OMDB_BASE_URL}/?${detailParams}`);
    const detailData = await detailRes.json();

    return detailData.Response === 'True' ? detailData : null;
}

function parseReleaseDate(dateStr) {
    if (!dateStr || dateStr === 'N/A') return new Date().toISOString();
    return new Date(dateStr).toISOString();
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}
