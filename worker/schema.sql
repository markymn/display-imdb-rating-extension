DROP TABLE IF EXISTS movies;

CREATE TABLE movies (
  prime_href TEXT PRIMARY KEY,
  imdb_id TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER NOT NULL,
  release_date TEXT NOT NULL,
  rating REAL,
  votes INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_imdb_id ON movies(imdb_id);
CREATE INDEX idx_title_year ON movies(title, year);
CREATE INDEX idx_updated_at ON movies(updated_at);
