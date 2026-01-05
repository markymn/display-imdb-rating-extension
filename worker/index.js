/**
 * Cloudflare Worker - IMDb Ratings Proxy with D1 Cache & Smart TTL
 */

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};

const OMDB_BASE_URL = 'https://www.omdbapi.com';

// TTL CONSTANTS
const TTL = {
    RECENT: 60 * 60 * 1000,           // 1 hour (unreleased or < 7 days old)
    MEDIUM: 24 * 60 * 60 * 1000,      // 1 day (8 - 14 days old)
    STABLE: 30 * 24 * 60 * 60 * 1000  // 30 days (> 14 days old)
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

            // Process batch in parallel
            const results = await Promise.all(
                movies.map(movie => processMovie(movie, env))
            );

            return jsonResponse({ results });
        } catch (error) {
            console.error('Worker error:', error);
            return jsonResponse({ error: 'Internal server error' }, 500);
        }
    }
};

/**
 * Process a single movie (Cache -> TTL Check -> Fetch -> Update)
 */
async function processMovie(movie, env) {
    let { title, href } = movie;
    if (!href) return { href, error: 'Missing href' };

    try {
        // 1. Check D1 Cache
        let cached;
        if (title) {
            cached = await env.DB.prepare('SELECT * FROM movies WHERE prime_href = ? AND title = ? COLLATE NOCASE')
                .bind(href, title)
                .first();
        } else {
            console.log(`[Worker] Direct href lookup for: ${href}`);
            cached = await env.DB.prepare('SELECT * FROM movies WHERE prime_href = ?')
                .bind(href)
                .first();
        }

        // 2. TTL Check
        if (cached) {
            if (!isDataStale(cached.release_date, cached.updated_at)) {
                return { href, data: cached, source: 'cache' };
            }
            // If stale, fall through to re-fetch - but ONLY if we have a title to search with
            if (!title) return { href, data: cached, source: 'cache-stale' };
        }

        // If no title and not in cache (or stale), we can't search OMDb
        if (!title) {
            return { href, error: 'OMDb Lookup skipped: Missing title' };
        }

        // Pre-clean: Remove "Director's Cut" if present at the end
        // Case insensitive match, and ensure we don't reduce the title to empty string
        const directorsCutRegex = /\s*Director's Cut$/i;
        if (directorsCutRegex.test(title) && title.replace(directorsCutRegex, '').trim().length > 0) {
            const cleaned = title.replace(directorsCutRegex, '').trim();
            console.log(`[Worker] Pre-cleaning "Director's Cut": "${title}" -> "${cleaned}"`);
            title = cleaned;
        }

        // 3. Fetch from OMDb (Using Title only)
        let omdbResult = await fetchOMDb(title, null, env.OMDB_API_KEY);

        // 4. Progressive Fallback Logic
        let attemptedTitle = title;

        // Fallback: Ampersand Replacement
        if (!omdbResult && (title.includes('&') || title.includes('&amp;'))) {
            attemptedTitle = title
                .replace(/\s*&amp;\s*/g, ' and ')
                .replace(/\s*&\s*/g, ' and ')
                .replace(/\s+/g, ' ')
                .trim();

            console.log(`[Worker] Fallback 1 - Ampersand: "${title}" -> "${attemptedTitle}"`);
            omdbResult = await fetchOMDb(attemptedTitle, null, env.OMDB_API_KEY);
        }

        // Fallback 2: Remove bracketed text at end (round brackets)
        if (!omdbResult) {
            const withoutBrackets = attemptedTitle.replace(/\s*\([^)]*\)\s*$/, '').trim();
            if (withoutBrackets !== attemptedTitle) {
                attemptedTitle = withoutBrackets;
                console.log(`[Worker] Fallback 2 - Remove round brackets: "${title}" -> "${attemptedTitle}"`);
                omdbResult = await fetchOMDb(attemptedTitle, null, env.OMDB_API_KEY);
            }
        }

        // Fallback 3: Remove square bracketed text at end (e.g., "Chango [Train]")
        if (!omdbResult) {
            const withoutSquareBrackets = attemptedTitle.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
            if (withoutSquareBrackets !== attemptedTitle) {
                attemptedTitle = withoutSquareBrackets;
                console.log(`[Worker] Fallback 3 - Remove square brackets: "${title}" -> "${attemptedTitle}"`);
                omdbResult = await fetchOMDb(attemptedTitle, null, env.OMDB_API_KEY);
            }
        }

        // Fallback 4: Remove text after dash (e.g., "Lemon - The Director cut")
        if (!omdbResult) {
            // Split by dash and take the first part
            const beforeDash = attemptedTitle.split(' - ')[0].trim();
            // Also check for simple hyphen without spaces if needed, but " - " is safer for titles like "X-Men"
            // For now, let's stick to " - " to avoid breaking hyphenated words
            if (beforeDash !== attemptedTitle && beforeDash.length > 0) {
                attemptedTitle = beforeDash;
                console.log(`[Worker] Fallback 4 - Remove after dash: "${title}" -> "${attemptedTitle}"`);
                omdbResult = await fetchOMDb(attemptedTitle, null, env.OMDB_API_KEY);
            }
        }

        // Fallback 5: Remove possessive prefix (e.g., "Dr. Seuss' The Grinch")
        if (!omdbResult) {
            const possessiveMatch = attemptedTitle.match(/^.*'s?\s+(.*)$/i);
            if (possessiveMatch && possessiveMatch[1]) {
                const rest = possessiveMatch[1].trim();
                if (rest.length > 0) {
                    attemptedTitle = rest;
                    console.log(`[Worker] Fallback 5 - Remove possessive prefix: "${title}" -> "${attemptedTitle}"`);
                    omdbResult = await fetchOMDb(attemptedTitle, null, env.OMDB_API_KEY);
                }
            }
        }

        // Fallback 6: Remove subtitle (text after colon)
        if (!omdbResult) {
            const beforeColon = attemptedTitle.split(':')[0].trim();
            if (beforeColon !== attemptedTitle && beforeColon.length > 0) {
                attemptedTitle = beforeColon;
                console.log(`[Worker] Fallback 6 - Remove after colon: "${title}" -> "${attemptedTitle}"`);
                omdbResult = await fetchOMDb(attemptedTitle, null, env.OMDB_API_KEY);
            }
        }

        if (!omdbResult) {
            return { href, error: 'OMDb Not Found' };
        }

        // 5. UPSERT into D1
        const now = new Date().toISOString();
        const movieData = {
            imdb_id: omdbResult.imdbID,
            title: title, // Use the verified Prime title (pre-cleaned) for consistency
            year: parseInt(omdbResult.Year) || 0, // Fallback to 0 if unknown
            release_date: parseReleaseDate(omdbResult.Released),
            prime_href: href,
            rating: parseFloat(omdbResult.imdbRating) || 0,
            votes: parseInt((omdbResult.imdbVotes || '0').replace(/,/g, '')) || 0,
            updated_at: now
        };

        await env.DB.prepare(`
            INSERT INTO movies (imdb_id, title, year, release_date, prime_href, rating, votes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(prime_href) DO UPDATE SET
                imdb_id = excluded.imdb_id,
                rating = excluded.rating,
                votes = excluded.votes,
                updated_at = excluded.updated_at
        `).bind(
            movieData.imdb_id,
            movieData.title,
            movieData.year,
            movieData.release_date,
            movieData.prime_href,
            movieData.rating,
            movieData.votes,
            movieData.updated_at
        ).run();

        return { href, data: movieData, source: 'api' };

    } catch (error) {
        console.error(`Error processing ${title}: `, error);
        return { href, error: error.message };
    }
}

/**
 * Check if data is stale based on release date
 */
function isDataStale(releaseDateStr, updatedAtStr) {
    if (!releaseDateStr) return true; // Treat unknown release date as stale

    const now = Date.now();
    const lastUpdate = new Date(updatedAtStr).getTime();
    const release = new Date(releaseDateStr).getTime();

    // Safety check for invalid dates
    if (isNaN(lastUpdate) || isNaN(release)) return true;

    const daysSinceRelease = (now - release) / (1000 * 60 * 60 * 24);
    const timeSinceUpdate = now - lastUpdate;

    if (daysSinceRelease <= 7) {
        return timeSinceUpdate > TTL.RECENT;
    } else if (daysSinceRelease <= 14) {
        return timeSinceUpdate > TTL.MEDIUM;
    } else {
        return timeSinceUpdate > TTL.STABLE;
    }
}

/**
 * Extract year from Prime Video URL
 * Pattern: /.../2024/.../ or similar
 */
function extractYearFromHref(href) {
    const match = href.match(/\b(19|20)\d{2}\b/);
    return match ? parseInt(match[0]) : null;
}

async function fetchOMDb(title, year, apiKey) {
    const params = new URLSearchParams({
        apikey: apiKey,
        t: title
    });
    if (year) params.append('y', year);

    const res = await fetch(`${OMDB_BASE_URL}/?${params}`);
    const data = await res.json();
    return data.Response === 'True' ? data : null;
}

function parseReleaseDate(dateStr) {
    if (!dateStr || dateStr === 'N/A') return new Date().toISOString(); // Default to now if unknown
    return new Date(dateStr).toISOString();
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: corsHeaders
    });
}
