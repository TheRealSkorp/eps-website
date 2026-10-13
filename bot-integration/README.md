# Connecting the Discord bot to the website

When a team confirms a result with `/result`, the bot posts it in Discord as before and also sends it to the
website. On the website it appears in **Admin > Matches > "Bot results waiting for approval"**. An admin presses
**Approve** (then **Save changes**) and it joins the fixtures, standings and bracket. **Reject** throws it away.
Nothing from the bot is public until an admin approves it.

## 1. On the website (Railway)

1. Make a secret. In any terminal:

       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

2. In Railway > your service > **Variables** add `BOT_TOKEN` with that value. Railway redeploys.
3. In the website admin > **Teams**, fill in the **Bot code** of every team (the same short code the bot uses,
   for example `GV`, `HCG`). Press **Save changes**.
4. Optional: name your rounds `Round 1`, `Round 2`, ... so the bot's round number picks the right round by itself.
   You can always change the round on the approval row.

## 2. In the bot

1. Copy `website_sync.py` next to `bot.py`.
2. In `bot.py` add the import with the other imports:

       import website_sync

3. In `PublishButton.callback`, right after the archive was updated to status `posted`
   (after the `except OSError: log.exception("Result was posted, but archive message metadata ...")` block, and
   next to `preview.stop()`), add one line:

       preview.stop()
       website_sync.schedule(preview, record)      # <- new line
       await interaction.edit_original_response(content=f"Posted: {message.jump_url}", view=None)

4. In the bot's `.env` add:

       WEBSITE_URL=https://your-website-address
       WEBSITE_BOT_TOKEN=the same value as BOT_TOKEN

   (`aiohttp` is already installed because discord.py needs it.)
5. Restart the bot.

If `WEBSITE_URL` or `WEBSITE_BOT_TOKEN` is empty, nothing is sent and the bot works exactly as before.
If the website is down, the bot retries a few times; posting in Discord is never affected.

## Sending results that were posted earlier

    python website_sync.py backfill            # reads DATA_DIR (default: data)
    python website_sync.py backfill path/to/data

It sends every archived result with status `posted`. Safe to run repeatedly: a result the website already
has (waiting or approved) is not duplicated.

## What is sent (for reference)

    POST {WEBSITE_URL}/api/bot/result        Authorization: Bearer <WEBSITE_BOT_TOKEN>
    {
      "match_id": "a1b2c3d4e5f6",
      "blue_code": "GV", "red_code": "HCG",          // blue = away = team A, red = home = team B
      "blue_name": "HC Great Victoria", "red_name": "HC Gladiators",
      "round": 2,
      "games": [{"blue": 3, "red": 1}, {"blue": 2, "red": 4}, {"blue": 5, "red": 2}],
      "played_at": 1760000000,
      "message_url": "https://discord.com/channels/..."
    }

The website answers `queued`, or `already_approved` if that `match_id` was approved before.
It only accepts 2 or 3 games with whole-number scores. Anything else is refused and logged by the bot.
