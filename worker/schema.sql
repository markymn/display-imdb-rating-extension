DROP TABLE IF EXISTS movies;

CREATE TABLE movies (
  prime_href TEXT PRIMARY KEY,
  imdb_id TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER NOT NULL,
  release_date TEXT NOT NULL,
  rating REAL,
  rt_rating TEXT,
  votes INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_imdb_id ON movies(imdb_id);
CREATE INDEX idx_title_year ON movies(title, year);
CREATE INDEX idx_updated_at ON movies(updated_at);

-- Episode ratings cache
CREATE TABLE IF NOT EXISTS episode_ratings (
    series_imdb_id TEXT NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    title TEXT,
    rating REAL,
    votes INTEGER,
    release_date TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (series_imdb_id, season, episode)
);

CREATE INDEX idx_episode_series_season ON episode_ratings(series_imdb_id, season);
