"""Sends confirmed match results from the Discord bot to the EPS website.

Copy this file next to bot.py (see README.md in this folder). Put two settings in the bot's .env file:

    WEBSITE_URL=https://your-website-address
    WEBSITE_BOT_TOKEN=the same secret value as BOT_TOKEN on the website

If either setting is empty nothing is sent, and the bot behaves exactly as before.
A result only reaches the website's "Bot results waiting for approval" list: an admin approves it there.
Sending never blocks or breaks posting a result in Discord: failures are only logged.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path

import aiohttp

log = logging.getLogger("hockey-bot.website")

_background: set[asyncio.Task] = set()   # keeps tasks alive until they finish


def _settings() -> tuple[str, str]:
    return os.getenv("WEBSITE_URL", "").strip().rstrip("/"), os.getenv("WEBSITE_BOT_TOKEN", "").strip()


def _pick_name(settings: dict, side: str) -> str:
    """The team name field is not known for sure, so take the first text field like blue*name / red*name."""
    for key, value in settings.items():
        if key.lower().startswith(side) and "name" in key.lower() and isinstance(value, str):
            return value
    return ""


def payload_from_preview(preview, record: dict) -> dict:
    """Build what the website expects from the bot's own objects (Blue = away = team A, Red = home = team B)."""
    s = preview.settings
    settings_dict = record.get("settings") or {}
    return {
        "match_id": preview.match_id,
        "blue_code": s.blue_code,
        "red_code": s.red_code,
        "blue_name": _pick_name(settings_dict, "blue"),
        "red_name": _pick_name(settings_dict, "red"),
        "round": preview.round_number,
        "games": [{"blue": g.blue_score, "red": g.red_score} for g in preview.games],
        "played_at": record.get("published_at"),
        "message_url": record.get("message_url", ""),
    }


async def send(payload: dict) -> bool:
    """POST one result. Retries a few times when the website is unreachable. Returns True when it was accepted."""
    url, token = _settings()
    if not url or not token:
        log.info("Website link is off (WEBSITE_URL / WEBSITE_BOT_TOKEN not set), result not sent.")
        return False
    timeout = aiohttp.ClientTimeout(total=15)
    for attempt in range(4):
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(f"{url}/api/bot/result", json=payload,
                                        headers={"Authorization": f"Bearer {token}"}) as response:
                    body = (await response.text())[:300]
                    if response.status == 200:
                        log.info("Result %s sent to the website: %s", payload.get("match_id"), body)
                        return True
                    if 400 <= response.status < 500 and response.status != 429:
                        # the website understood the request and refused it, so retrying cannot help
                        log.error("Website refused result %s (HTTP %s): %s", payload.get("match_id"), response.status, body)
                        return False
                    log.warning("Website answered HTTP %s, will retry.", response.status)
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            log.warning("Website not reachable (%s), will retry.", exc.__class__.__name__)
        await asyncio.sleep(3 * (attempt + 1))
    log.error("Could not send result %s to the website. It is still saved in the data folder: "
              "run `python website_sync.py backfill` later to resend.", payload.get("match_id"))
    return False


async def push_result(preview, record: dict) -> None:
    try:
        payload = payload_from_preview(preview, record)
    except Exception:  # never let this break posting
        log.exception("Could not build the website payload")
        return
    await send(payload)


def schedule(preview, record: dict) -> None:
    """Call this right after a result has been posted to Discord. Runs in the background."""
    task = asyncio.get_running_loop().create_task(push_result(preview, record))
    _background.add(task)
    task.add_done_callback(_background.discard)


# ---- command line: resend results that were posted earlier (safe to run repeatedly) ----
def _payload_from_archive(record: dict) -> dict | None:
    settings = record.get("settings") or {}
    games = []
    for g in record.get("games") or []:
        blue = g.get("blue_score", g.get("blue"))
        red = g.get("red_score", g.get("red"))
        if not isinstance(blue, int) or not isinstance(red, int):
            return None
        games.append({"blue": blue, "red": red})
    if not record.get("match_id") or not settings.get("blue_code") or not settings.get("red_code") or len(games) < 2:
        return None
    return {
        "match_id": record["match_id"],
        "blue_code": settings["blue_code"], "red_code": settings["red_code"],
        "blue_name": _pick_name(settings, "blue"), "red_name": _pick_name(settings, "red"),
        "round": record.get("round_number"),
        "games": games,
        "played_at": record.get("published_at"),
        "message_url": record.get("message_url", ""),
    }


async def _backfill(folder: Path) -> None:
    sent = skipped = failed = 0
    for path in sorted(folder.glob("*.json")):
        if not re.fullmatch(r"[A-Za-z0-9_-]{4,64}", path.stem):
            continue
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict) or record.get("status") != "posted":
            continue
        payload = _payload_from_archive(record)
        if payload is None:
            print(f"skipped {path.name}: not in the expected format")
            skipped += 1
            continue
        if await send(payload):
            sent += 1
        else:
            failed += 1
    print(f"done: {sent} sent, {skipped} skipped, {failed} failed")


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if len(sys.argv) >= 2 and sys.argv[1] == "backfill":
        asyncio.run(_backfill(Path(sys.argv[2] if len(sys.argv) > 2 else os.getenv("DATA_DIR", "data"))))
    else:
        print("Usage: python website_sync.py backfill [data_folder]")
