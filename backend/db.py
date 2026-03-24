"""
NeuroVibe SQLite database module.
Stores users, per-user EEG baselines, sessions, and evaluation feedback.

Database file: backend/neurovibe.db  (auto-created on first run)
"""
import sqlite3
import json
import os
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(__file__), 'neurovibe.db')


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    """Create tables if they don't exist. Safe to call multiple times."""
    with _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                username   TEXT    UNIQUE NOT NULL,
                created_at TEXT    DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS baselines (
                user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                data       BLOB    NOT NULL,
                updated_at TEXT    DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
                mode             TEXT    NOT NULL,
                started_at       TEXT,
                ended_at         TEXT,
                duration_seconds INTEGER,
                data_json        TEXT    NOT NULL,
                created_at       TEXT    DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS feedback (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
                session_id     INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
                sus_score      REAL,
                responses_json TEXT    NOT NULL,
                created_at     TEXT    DEFAULT (datetime('now'))
            );
        """)


# ── Users ─────────────────────────────────────────────────────────────────────

def get_users() -> list:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, username, created_at FROM users ORDER BY created_at"
        ).fetchall()
        return [dict(r) for r in rows]


def create_user(username: str) -> Optional[dict]:
    """Returns the new user dict, or None if the username is already taken."""
    try:
        with _connect() as conn:
            conn.execute("INSERT INTO users (username) VALUES (?)", (username,))
            row = conn.execute(
                "SELECT id, username, created_at FROM users WHERE username = ?", (username,)
            ).fetchone()
            return dict(row) if row else None
    except sqlite3.IntegrityError:
        return None


def get_user(user_id: int) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, username, created_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        return dict(row) if row else None


# ── Baselines ─────────────────────────────────────────────────────────────────

def save_baseline(user_id: int, blob: bytes) -> None:
    """Upsert the user's baseline pickle blob into the DB."""
    with _connect() as conn:
        conn.execute(
            """INSERT INTO baselines (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
               ON CONFLICT(user_id) DO UPDATE
                 SET data = excluded.data, updated_at = excluded.updated_at""",
            (user_id, blob)
        )


def load_baseline(user_id: int) -> Optional[bytes]:
    """Return the raw pickle bytes for the user's baseline, or None."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT data FROM baselines WHERE user_id = ?", (user_id,)
        ).fetchone()
        return bytes(row['data']) if row else None


def has_baseline(user_id: int) -> bool:
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM baselines WHERE user_id = ?", (user_id,)
        ).fetchone()
        return row is not None


# ── Sessions ──────────────────────────────────────────────────────────────────

def save_session(
    user_id: Optional[int],
    mode: str,
    started_at: str,
    ended_at: str,
    duration_seconds: int,
    data_json: str,
) -> int:
    """Insert a session record and return its new id."""
    with _connect() as conn:
        cur = conn.execute(
            """INSERT INTO sessions
                 (user_id, mode, started_at, ended_at, duration_seconds, data_json)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (user_id, mode, started_at, ended_at, duration_seconds, data_json)
        )
        return cur.lastrowid


# ── Feedback ──────────────────────────────────────────────────────────────────

def save_feedback(
    user_id: Optional[int],
    session_id: Optional[int],
    sus_score: float,
    responses_json: str,
) -> int:
    """Insert a feedback record and return its new id."""
    with _connect() as conn:
        cur = conn.execute(
            """INSERT INTO feedback
                 (user_id, session_id, sus_score, responses_json)
               VALUES (?, ?, ?, ?)""",
            (user_id, session_id, sus_score, responses_json)
        )
        return cur.lastrowid
