"""Voice chats the plugin archived come back once they're used (hermes-conduit#1124).

A standalone call's row, and a Classic chat a voice call started, are archived
with Hermes' idle-sweep stamp (``auto_archived``) when the call ends. Hermes
un-archives such a row when a turn reopens it, but a Classic chat can still be
open when its call ends, and then nothing reopens it: the next turn there runs
in a chat Desktop's list doesn't show. The pre_llm_call hook calls
``bring_back`` with the turn's session, which un-archives it the way Hermes'
reopen does (a lineage someone archived on purpose stays archived).
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

STATE_DB = "state.db"
# Kept in step with dashboard/plugin_api.py.
VOICE_TAGS_KEY = "conduit.voice.tags"
ARCHIVED_KINDS = frozenset({"call", "classic"})


def _archived_voice_chat(path: Path, session_id: str) -> bool:
    """One read-only look: the row carries the sweep's stamp and is a voice
    chat. Most turns stop at the first query."""
    conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=1.0)
    try:
        row = conn.execute("SELECT archived, auto_archived FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row or not row[0] or not row[1]:
            return False
        meta = conn.execute("SELECT value FROM state_meta WHERE key = ?", (VOICE_TAGS_KEY,)).fetchone()
    finally:
        conn.close()
    try:
        tags = json.loads(meta[0]) if meta and meta[0] else {}
    except ValueError:
        return False
    tag = tags.get(session_id) if isinstance(tags, dict) else None
    return isinstance(tag, dict) and tag.get("kind") in ARCHIVED_KINDS


def _open_session_db(path: Path):
    from hermes_state import SessionDB

    return SessionDB(db_path=path)


def bring_back(home: Path, session_id: str, open_db: Callable[[Path], object] = _open_session_db) -> bool:
    """Un-archives ``session_id`` when the plugin archived it as a voice chat.
    True when it did. Never raises: a hook must not break the turn."""
    if not session_id:
        return False
    path = Path(home) / STATE_DB
    try:
        if not path.exists() or not _archived_voice_chat(path, session_id):
            return False
        db = open_db(path)
    except Exception:  # noqa: BLE001
        logger.debug("conduit_push: couldn't check whether voice chat %s was archived", session_id, exc_info=True)
        return False
    try:
        write: Optional[Callable] = getattr(db, "_execute_write", None)
        unarchive: Optional[Callable] = getattr(db, "_unarchive_auto_archived_lineage", None)
        if write is None or unarchive is None:
            return False
        # Its own result isn't kept: sqlite3 may not count a CTE update's rows.
        write(lambda conn: unarchive(conn, session_id))
        return True
    except Exception:  # noqa: BLE001
        logger.warning("conduit_push: couldn't un-archive voice chat %s", session_id, exc_info=True)
        return False
    finally:
        try:
            db.close()
        except Exception:  # noqa: BLE001
            logger.debug("conduit_push: closing the session store failed", exc_info=True)
