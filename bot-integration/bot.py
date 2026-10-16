"""Screenshot-to-embed Discord bot. Run with: python bot.py"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import time
import unicodedata
import uuid

import discord
from discord import app_commands
from dotenv import load_dotenv

from embeds import Awards, MatchSettings, make_embed
from hockey import Game, aggregate, game_to_dict, goalie_lines, parse_goalie_lines, parse_skater_lines, skater_lines
from ocr import MAX_BYTES, OCRFailure, ScreenshotReader
from league import LeagueService, discord_failure_message, is_staff
from players import PlayerService
from result_history import SavedResult, read_history, summary_embed
import website_sync

log = logging.getLogger("hockey-bot")


def env_id(name: str) -> int | None:
    value = os.getenv(name, "").strip()
    if not value:
        return None
    if not value.isdigit() or int(value) <= 0:
        raise ValueError(f"{name} must be a positive Discord ID, or left blank.")
    return int(value)


class ResultClient(discord.Client):
    def __init__(self):
        intents = discord.Intents.none()
        intents.guilds = True
        intents.members = os.getenv("MEMBERS_INTENT", "false").strip().lower() in {"true", "1", "yes", "on"}
        super().__init__(intents=intents, allowed_mentions=discord.AllowedMentions.none())
        self.tree = app_commands.CommandTree(self)
        self.reader: ScreenshotReader | None = None
        self.ocr_slots = asyncio.Semaphore(2)
        self.guild_id = env_id("DISCORD_GUILD_ID")
        self.a_team_role_id = env_id("A_TEAM_ROLE_ID")
        self.result_role_id = env_id("RESULT_ROLE_ID")
        self.data_dir = Path(os.getenv("DATA_DIR", "data"))
        self.league: LeagueService | None = None
        self.players: PlayerService | None = None
        self.tree.add_command(result_command)
        self.tree.add_command(result_show_command)
        self.tree.add_command(help_command)
        self.tree.add_command(nickname_command)
        self.tree.on_error = self.command_error

    async def setup_hook(self):
        try:
            self.reader = ScreenshotReader()
        except OCRFailure as exc:
            self.reader = None
            log.warning("Screenshot reading is unavailable: %s Other commands will still start.", exc)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.league = LeagueService(self, self.data_dir)
        await self.league.start()
        self.players = PlayerService(self, self.league)
        await self.players.start()
        if self.guild_id:
            guild = discord.Object(id=self.guild_id)
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()

    async def on_ready(self):
        if self.players is not None:
            self.players.start_card_refresh()
        log.info("Logged in as %s. Results, league commands, registration, transfers and nicknames are ready.", self.user)

    async def close(self):
        if self.players is not None:
            self.players.stop()
        if self.league is not None:
            self.league.stop()
        await super().close()

    async def command_error(self, interaction: discord.Interaction, error: app_commands.AppCommandError):
        if isinstance(error, app_commands.CommandOnCooldown):
            text = f"Please wait {error.retry_after:.0f} seconds, then try again."
        elif isinstance(error, app_commands.NoPrivateMessage):
            text = "Use this command inside your Discord server."
        else:
            log.error("Slash command failed", exc_info=(type(error), error, error.__traceback__))
            text = "The command failed. Check the bot log, then try again."
        if interaction.response.is_done():
            await interaction.followup.send(text, ephemeral=True)
        else:
            await interaction.response.send_message(text, ephemeral=True)


class EditGame(discord.ui.Modal):
    def __init__(self, preview: "ResultPreview", index: int):
        super().__init__(title=f"Edit Game {index + 1}", timeout=300)
        self.preview = preview
        self.index = index
        game = preview.games[index]
        self.score = discord.ui.TextInput(default=f"{game.blue_score}-{game.red_score}", max_length=12)
        self.blue = discord.ui.TextInput(style=discord.TextStyle.paragraph, default=skater_lines(game.blue_skaters), required=False, max_length=2000)
        self.red = discord.ui.TextInput(style=discord.TextStyle.paragraph, default=skater_lines(game.red_skaters), required=False, max_length=2000)
        self.goalies = discord.ui.TextInput(style=discord.TextStyle.paragraph, default=goalie_lines(game), required=False, max_length=2000)
        self.stars = discord.ui.TextInput(default="; ".join(game.stars), required=False, max_length=200)
        for label, description, component in (
            ("Score: Away/Blue – Home/Red", "Example: 1-3", self.score),
            ("Away / Blue players", "One per line: #99 Name: 2G 1A 5S (shots optional)", self.blue),
            ("Home / Red players", "One per line: #99 Name: 2G 1A 5S (shots optional)", self.red),
            ("Goalies: saves / shots faced", "One per line: Blue #83 Name: 19/22 or Red #11 Name: 7/8", self.goalies),
            ("Game's three stars", "Names in first, second, third order, separated by ;", self.stars),
        ):
            if component is self.goalies and not game.goalie_stats_available and not (game.blue_goalies or game.red_goalies):
                continue
            self.add_item(discord.ui.Label(text=label, description=description, component=component))

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return await self.preview.interaction_check(interaction)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            match = re.fullmatch(r"\s*(\d{1,2})\s*[-–:]\s*(\d{1,2})\s*", self.score.value)
            if not match:
                raise ValueError("Use Away/Blue score first, then Home/Red, such as 1-3.")
            blue_goalies, red_goalies = parse_goalie_lines(self.goalies.value)
            old = self.preview.games[self.index]
            game = Game(int(match[1]), int(match[2]), parse_skater_lines(self.blue.value), parse_skater_lines(self.red.value), blue_goalies, red_goalies,
                        [name.strip() for name in self.stars.value.split(";") if name.strip()], old.blue_shots, old.red_shots,
                        goalie_stats_available=old.goalie_stats_available)
            if len(game.stars) > 3:
                raise ValueError("Supply at most three game stars.")
            game.validate()
        except ValueError as exc:
            await interaction.response.send_message(str(exc) + " Reopen Edit game to try again.", ephemeral=True)
            return
        async with self.preview.lock:
            if self.preview.closed:
                await interaction.response.send_message("This preview is closed. Start a new /result.", ephemeral=True)
                return
            self.preview.games[self.index] = game
            await self.preview.refresh(interaction)

    async def on_error(self, interaction: discord.Interaction, error: Exception):
        log.error("Game editor failed", exc_info=(type(error), error, error.__traceback__))
        if not interaction.response.is_done():
            await interaction.response.send_message("Could not save the edit. Try shorter names or check the bot log.", ephemeral=True)


class EditButton(discord.ui.Button):
    def __init__(self, index: int):
        super().__init__(label=f"Edit G{index + 1}", style=discord.ButtonStyle.secondary, row=0)
        self.index = index

    async def callback(self, interaction: discord.Interaction):
        await interaction.response.send_modal(EditGame(self.view, self.index))


class AwardSelect(discord.ui.Select):
    def __init__(self, preview: "ResultPreview", index: int):
        series = aggregate(preview.games)
        label = ("Player of the match", "First star", "Second star", "Third star")[index]
        selected = preview.awards.pom if index == 0 else (preview.awards.stars[index - 1] if len(preview.awards.stars) >= index else None)
        options = []
        for player in series.skaters + series.goalies:
            details = f"{player.points}P ({player.goals}G {player.assists}A)" if player.role == "skater" else f"{player.saves}/{player.faced} saves"
            options.append(discord.SelectOption(label=f"{player.name} · {preview.settings.code(player.side)}"[:100], value=player.key[:100], description=details, default=player.key == selected))
        super().__init__(placeholder=label, options=options[:25], min_values=1, max_values=1, row=index + 1)
        self.index = index

    async def callback(self, interaction: discord.Interaction):
        preview: ResultPreview = self.view
        async with preview.lock:
            if preview.closed:
                await interaction.response.send_message("This preview is closed.", ephemeral=True)
                return
            key = self.values[0]
            if self.index == 0:
                preview.awards.pom = key
            else:
                position = self.index - 1
                existing = preview.awards.stars
                if position >= len(existing):
                    if key in existing:
                        await interaction.response.send_message("Choose a different player for this star.", ephemeral=True)
                        return
                    existing.append(key)
                else:
                    if key in existing:
                        other = existing.index(key)
                        existing[other] = existing[position]
                    existing[position] = key
            await preview.refresh(interaction)


class PublishButton(discord.ui.Button):
    def __init__(self, disabled: bool):
        super().__init__(label="Confirm & post", style=discord.ButtonStyle.success, row=0, disabled=disabled)

    async def callback(self, interaction: discord.Interaction):
        preview: ResultPreview = self.view
        async with preview.lock:
            if preview.closed:
                await interaction.response.send_message("This result has already been posted or closed.", ephemeral=True)
                return
            series = aggregate(preview.games)
            if not series.complete:
                await interaction.response.send_message("Resolve the series errors before posting.", ephemeral=True)
                return
            embed = make_embed(series, preview.settings, preview.awards, preview.match_id, preview.round_number)
            await interaction.response.defer()
            client: ResultClient = interaction.client
            if getattr(client, "league", None) is not None:
                try:
                    preview.settings = await registered_result_settings(interaction, preview.settings.blue_code,
                                                                         preview.settings.red_code, preview.settings.label)
                    embed = make_embed(series, preview.settings, preview.awards, preview.match_id, preview.round_number)
                except ValueError as exc:
                    await interaction.followup.send(str(exc), ephemeral=True)
                    return
            if not await can_post(interaction, preview.channel, client, team_codes=(preview.settings.blue_code, preview.settings.red_code)):
                await interaction.followup.send("You or the bot cannot post in this channel.", ephemeral=True)
                return
            record = {"match_id": preview.match_id, "settings": asdict(preview.settings), "games": [game_to_dict(g) for g in preview.games],
                      "awards": asdict(preview.awards), "reporter_id": preview.owner_id, "guild_id": interaction.guild_id,
                      "source_hashes": preview.source_hashes, "status": "prepared", "round_number": preview.round_number,
                      "round_id": preview.round_id, "fixture_id": preview.fixture_id, "channel_id": preview.channel.id}
            archive = client.data_dir / f"{preview.match_id}.json"
            try:
                await asyncio.to_thread(write_record, archive, record)
            except OSError:
                log.exception("Could not save the result before posting")
                await interaction.followup.send("Could not save the result. Check that DATA_DIR is writable, then confirm again.", ephemeral=True)
                return
            # Close before sending, so repeated clicks cannot post twice.
            preview.closed = True
            try:
                message = await preview.channel.send(embed=embed, allowed_mentions=discord.AllowedMentions.none())
            except (discord.HTTPException, OSError):
                log.exception("Discord did not confirm the results message")
                record["status"] = "delivery_unconfirmed"
                try:
                    await asyncio.to_thread(write_record, archive, record)
                except OSError:
                    log.exception("Could not update delivery status")
                await interaction.edit_original_response(content="Discord did not confirm the post. Check the results channel before starting another /result.", view=None)
                preview.stop()
                return
            record.update(status="posted", published_at=time.time(), channel_id=message.channel.id, message_id=message.id, message_url=message.jump_url)
            try:
                await asyncio.to_thread(write_record, archive, record)
            except OSError:
                log.exception("Result was posted, but archive message metadata could not be updated")
            preview.stop()
            # Send the confirmed result to the EPS website (runs in the background; never blocks or breaks the post).
            website_sync.schedule(preview, record)
            await interaction.edit_original_response(content=f"Posted: {message.jump_url}", view=None)


class CancelButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="Cancel", style=discord.ButtonStyle.danger, row=0)

    async def callback(self, interaction: discord.Interaction):
        preview: ResultPreview = self.view
        async with preview.lock:
            if preview.closed:
                await interaction.response.send_message("This preview is already closed.", ephemeral=True)
                return
            preview.closed = True
            preview.stop()
            await interaction.response.edit_message(content="Result cancelled.", embed=None, view=None)


class ResultPreview(discord.ui.View):
    def __init__(self, owner_id: int, channel: discord.TextChannel | discord.Thread, settings: MatchSettings, games: list[Game], source_hashes: list[str],
                 *, round_number: int | None = None, round_id: int | None = None, fixture_id: int | None = None):
        super().__init__(timeout=600)
        self.owner_id, self.channel, self.settings, self.games = owner_id, channel, settings, games
        self.source_hashes = source_hashes
        self.round_number, self.round_id, self.fixture_id = round_number, round_id, fixture_id
        self.match_id = uuid.uuid4().hex[:12]
        self.awards = Awards()
        self.message: discord.WebhookMessage | None = None
        self.closed = False
        self.lock = asyncio.Lock()
        self.rebuild()

    def rebuild(self):
        series = aggregate(self.games)
        self.awards.reconcile(series)
        self.clear_items()
        for index in range(len(self.games)):
            self.add_item(EditButton(index))
        self.add_item(PublishButton(not series.complete))
        self.add_item(CancelButton())
        if series.players:
            for index in range(4):
                self.add_item(AwardSelect(self, index))

    def content(self) -> str:
        series = aggregate(self.games)
        text = f"**Result preview** · {self.channel.mention}"
        if series.errors:
            text += "\n\n**Cannot post yet:**\n" + "\n".join(f"• {e}" for e in series.errors)
        if series.warnings:
            text += "\n\n**Check:**\n" + "\n".join(f"• {w}" for w in series.warnings[:7])
            if len(series.warnings) > 7:
                text += f"\n• {len(series.warnings) - 7} more warnings; review all games."
        # User-supplied nicknames cannot create mentions in the warning text.
        return text.replace("@", "@\u200b")[:1950]

    def embed(self) -> discord.Embed:
        return make_embed(aggregate(self.games), self.settings, self.awards, self.match_id, self.round_number)

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("Only the person who submitted this result can edit or post it.", ephemeral=True)
            return False
        if self.closed:
            await interaction.response.send_message("This preview is closed. Start a new /result.", ephemeral=True)
            return False
        return True

    async def refresh(self, interaction: discord.Interaction):
        self.rebuild()
        await interaction.response.edit_message(content=self.content(), embed=self.embed(), view=self, allowed_mentions=discord.AllowedMentions.none())

    async def on_timeout(self):
        async with self.lock:
            self.closed = True
            if self.message:
                try:
                    await self.message.edit(content="Preview expired. Start a new /result to submit this series.", view=None)
                except discord.HTTPException:
                    pass

    async def on_error(self, interaction: discord.Interaction, error: Exception, item):
        log.error("Preview interaction failed", exc_info=(type(error), error, error.__traceback__))
        if interaction.response.is_done():
            await interaction.followup.send("Could not update the preview. Check the bot log or start a new /result.", ephemeral=True)
        else:
            await interaction.response.send_message("Could not update the preview. Check the bot log or start a new /result.", ephemeral=True)


def write_record(path: Path, record: dict):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


async def registered_result_settings(interaction, blue_reference: str, red_reference: str, event: str | None = None) -> MatchSettings:
    league = interaction.client.league
    if league is None or not interaction.guild:
        raise ValueError("The league is not ready. Try again shortly.")
    blue, red = await asyncio.gather(league.db(league.store.get_team, interaction.guild_id, blue_reference),
                                     league.db(league.store.get_team, interaction.guild_id, red_reference))
    if blue is None or red is None:
        raise ValueError("Choose registered team codes or roles. Staff can use /team_setup.")
    if blue.code == red.code:
        raise ValueError("Choose two different teams.")
    if not interaction.guild.get_role(blue.role_id) or not interaction.guild.get_role(red.role_id):
        raise ValueError("A team role is missing. Staff must update /team_setup.")
    heading = event.strip() if event else (blue.division if blue.division and blue.division == red.division else league.league_name) + " · BO3"
    settings = MatchSettings(blue.name, red.name, blue.code, red.code, heading, blue.logo, red.logo, blue.role_id, red.role_id)
    settings.validate()
    return settings


async def result_team_choices(interaction, current: str):
    league = getattr(interaction.client, "league", None)
    return await league.autocomplete_teams(interaction, current) if league else []


async def registered_result_round(interaction, settings: MatchSettings, number: int | None) -> dict:
    if number is not None and (type(number) is not int or not 1 <= number <= 9999):
        raise ValueError("Round must be 1–9999.")
    league = interaction.client.league
    fixtures = await league.db(league.store.result_fixtures, interaction.guild_id,
                               settings.blue_code, settings.red_code, number)
    if len(fixtures) > 1:
        if number is None:
            raise ValueError("These teams have several matches. Choose the round option.")
        raise ValueError("These teams have several matches in this round. Ask staff to check the schedule.")
    return fixtures[0] if fixtures else {"round_number": number, "round_id": None, "fixture_id": None}


async def can_read_result(interaction, result: SavedResult) -> bool:
    """A private lookup respects access to the original result channel."""
    if is_staff(interaction):
        return True
    if not result.channel_id:
        return False
    client = interaction.client
    channel = client.get_channel(result.channel_id)
    if channel is None:
        try:
            channel = await client.fetch_channel(result.channel_id)
        except (discord.HTTPException, OSError):
            return False
    if not isinstance(channel, (discord.TextChannel, discord.Thread)) or channel.guild.id != interaction.guild_id:
        return False
    permissions = channel.permissions_for(interaction.user)
    if not permissions.view_channel or not permissions.read_message_history:
        return False
    if isinstance(channel, discord.Thread) and channel.is_private() and not permissions.manage_threads:
        if interaction.user.id != channel.owner_id:
            try:
                await channel.fetch_member(interaction.user.id)
            except (discord.HTTPException, OSError):
                return False
    return True


@app_commands.command(name="result_show", description="Show a saved match result.")
@app_commands.guild_only()
@app_commands.checks.cooldown(1, 5, key=lambda i: (i.guild_id, i.user.id))
@app_commands.describe(match="Team codes or roles: GV vs HCG", round="Round number; blank = latest result")
async def result_show_command(interaction: discord.Interaction, match: app_commands.Range[str, 3, 64],
                              round: app_commands.Range[int, 1, 9999] | None = None):
    await interaction.response.defer(ephemeral=True, thinking=True)
    client: ResultClient = interaction.client
    try:
        if not interaction.guild or not isinstance(interaction.user, discord.Member):
            raise ValueError("Use this command in your server.")
        if client.league is None:
            raise ValueError("The league is not ready. Try again shortly.")
        pairs = await client.league.db(client.league.store.resolve_fixtures, interaction.guild_id, match, include_archived=True)
        if len(pairs) != 1:
            raise ValueError("Choose one match: GV vs HCG.")
        first, second = pairs[0]
        aliases = await client.league.db(client.league.store.history_team_codes, interaction.guild_id)
        results = await asyncio.to_thread(read_history, client.data_dir, interaction.guild_id)
        saved = None
        for candidate in results:
            if candidate.matches(first, second, round, aliases=aliases) and await can_read_result(interaction, candidate):
                saved = candidate
                break
        if saved is None:
            raise ValueError("No saved result found.")
        displayed_first = saved.settings.blue_code if aliases.get(saved.settings.blue_code.upper(), saved.settings.blue_code.upper()) == first else saved.settings.red_code
        await interaction.followup.send(embed=summary_embed(saved, displayed_first, client.league.league_name),
                                        ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
    except ValueError as exc:
        await interaction.followup.send(str(exc).replace("@", "@\u200b"), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
    except (discord.HTTPException, OSError) as exc:
        log.error("Result lookup failed", exc_info=(type(exc), exc, exc.__traceback__))
        await interaction.followup.send("Could not load the result. Try again.", ephemeral=True)


async def can_post(interaction: discord.Interaction, channel: discord.TextChannel | discord.Thread, client: ResultClient,
                   *, team_codes: tuple[str, str] | None = None) -> bool:
    if not interaction.guild or not isinstance(interaction.user, discord.Member):
        return False
    staff = is_staff(interaction)
    roles = {r.id for r in interaction.user.roles}
    reporter = client.result_role_id is not None and client.result_role_id in roles
    if client.result_role_id and not staff and not reporter:
        return False
    if team_codes is not None:
        if client.league is None:
            return False
        teams = await asyncio.gather(*(client.league.db(client.league.store.get_team, interaction.guild_id, code) for code in team_codes))
        if any(team is None or interaction.guild.get_role(team.role_id) is None for team in teams) or teams[0].code == teams[1].code:
            return False
        if not (staff or reporter or any(team.role_id in roles or team.is_manager(interaction.user.id) for team in teams)):
            return False
    member = interaction.guild.me
    if member is None:
        member = await interaction.guild.fetch_member(client.user.id)
    bot_perms, user_perms = channel.permissions_for(member), channel.permissions_for(interaction.user)
    send_key = "send_messages_in_threads" if isinstance(channel, discord.Thread) else "send_messages"
    return bot_perms.view_channel and bot_perms.embed_links and getattr(bot_perms, send_key) and user_perms.view_channel and getattr(user_perms, send_key)


async def read_result_image(attachment: discord.Attachment, index: int) -> bytes:
    try:
        try:
            return await attachment.read()
        except (discord.Forbidden, discord.NotFound):
            # Discord's image proxy can still have a readable copy when the
            # original attachment URL no longer works. Never log signed URLs.
            proxy = getattr(attachment, "proxy_url", None)
            if not proxy or proxy == getattr(attachment, "url", None):
                raise
            return await attachment.read(use_cached=True)
    except (discord.HTTPException, OSError) as exc:
        log.error("Result screenshot Game %s download failed", index, exc_info=(type(exc), exc, exc.__traceback__))
        raise OCRFailure(f"Could not download Game {index}. Upload that screenshot again in /result.") from exc


@app_commands.command(name="result", description="Submit a BO3 result from screenshots.")
@app_commands.guild_only()
@app_commands.checks.cooldown(1, 30, key=lambda i: (i.guild_id, i.user.id))
@app_commands.autocomplete(blue_team=result_team_choices, red_team=result_team_choices)
@app_commands.describe(
    blue_team="Registered team code or role on Away / Blue",
    red_team="Registered team code or role on Home / Red",
    game1="Full final-results menu for Game 1",
    game2="Full final-results menu for Game 2",
    game3="Game 3 only if the first two games split 1–1",
    event="Event heading at the top of the embed",
    round="Round number, such as 2",
)
async def result_command(interaction: discord.Interaction, blue_team: str, red_team: str, game1: discord.Attachment, game2: discord.Attachment,
                         game3: discord.Attachment | None = None, event: str | None = None, round: app_commands.Range[int, 1, 9999] | None = None):
    client: ResultClient = interaction.client
    await interaction.response.defer(ephemeral=True, thinking=True)
    stage = "team settings"
    try:
        settings = await registered_result_settings(interaction, blue_team, red_team, event)
        stage = "results channel"
        channel = interaction.channel
        if not isinstance(channel, (discord.TextChannel, discord.Thread)) or channel.guild.id != interaction.guild_id:
            raise ValueError("Use this command in a text channel or thread.")
        if not await can_post(interaction, channel, client, team_codes=(settings.blue_code, settings.red_code)):
            raise ValueError("Only these teams, reporters or staff can submit results. Check this channel's permissions.")
        stage = "round settings"
        round_info = await registered_result_round(interaction, settings, round)
        if client.reader is None:
            raise OCRFailure("Screenshot reading needs Tesseract. Staff: install it on the host, then restart the bot.")
        attachments = [game1, game2] + ([game3] if game3 else [])
        if any(a.size > MAX_BYTES for a in attachments):
            raise ValueError("Each screenshot must be 10 MB or smaller.")
        payloads = await asyncio.gather(*(read_result_image(a, index) for index, a in enumerate(attachments, 1)))
        hashes = [hashlib.sha256(data).hexdigest() for data in payloads]
        if len(set(hashes)) != len(hashes):
            raise ValueError("The same screenshot was uploaded twice. Supply a separate screenshot for each game.")
        games = []
        async with client.ocr_slots:
            for index, data in enumerate(payloads, 1):
                try:
                    game = await asyncio.to_thread(client.reader.read, data)
                except ValueError as exc:
                    raise OCRFailure(f"Game {index}: {exc}") from exc
                games.append(game)
        view = ResultPreview(interaction.user.id, channel, settings, games, hashes,
                             round_number=round_info["round_number"], round_id=round_info["round_id"], fixture_id=round_info["fixture_id"])
        embed = view.embed()
        stage = "result preview"
        view.message = await interaction.followup.send(content=view.content(), embed=embed, view=view, ephemeral=True, wait=True, allowed_mentions=discord.AllowedMentions.none())
    except ValueError as exc:
        await interaction.followup.send(str(exc).replace("@", "@\u200b"), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())
    except discord.HTTPException as exc:
        log.error("Result failed during %s", stage, exc_info=(type(exc), exc, exc.__traceback__))
        text = discord_failure_message(exc, stage)
        await interaction.followup.send(text.replace("@", "@\u200b"), ephemeral=True, allowed_mentions=discord.AllowedMentions.none())


@app_commands.command(name="nickname", description="Change your server nickname.")
@app_commands.guild_only()
@app_commands.checks.cooldown(1, 10, key=lambda i: (i.guild_id, i.user.id))
@app_commands.describe(name="Your new nickname. Leave blank to reset.")
async def nickname_command(interaction: discord.Interaction, name: app_commands.Range[str, 1, 32] | None = None):
    await interaction.response.defer(ephemeral=True, thinking=True)
    try:
        member = interaction.user
        guild = interaction.guild
        if guild is None or not isinstance(member, discord.Member) or member.guild.id != guild.id:
            raise ValueError("Use this command in your server.")
        nickname = None if name is None else unicodedata.normalize("NFC", " ".join(name.split()))
        if nickname is not None and (not 1 <= len(nickname) <= 32 or any(unicodedata.category(c) == "Cc" for c in nickname)):
            raise ValueError("Use a nickname with 1–32 characters.")
        if nickname == member.nick:
            text = "Nickname already set." if nickname is not None else "Your nickname is already reset."
        else:
            if member.id == guild.owner_id:
                raise ValueError("Discord blocks bots from changing the server owner's nickname. Change it in Discord.")
            bot_member = guild.me
            if bot_member is None:
                bot_member = await guild.fetch_member(interaction.client.user.id)
            if not bot_member.guild_permissions.manage_nicknames:
                raise ValueError("The bot needs Manage Nicknames.")
            if bot_member.top_role <= member.top_role:
                raise ValueError("Move the bot's role above your highest role, then try again.")
            await member.edit(nick=nickname, reason=f"Self-service nickname change by member {member.id}.")
            text = "Nickname changed." if nickname is not None else "Nickname reset."
    except ValueError as exc:
        text = str(exc)
    except discord.Forbidden:
        text = "Discord blocked the change. Check Manage Nicknames and the bot's role position."
    except discord.HTTPException as exc:
        log.warning("Nickname change failed for member %s: HTTP %s, code %s", interaction.user.id, exc.status, exc.code)
        text = "Discord rejected this nickname. Try a different name." if exc.code == 50035 else "Could not change your nickname. Try again."
    await interaction.followup.send(text, ephemeral=True, allowed_mentions=discord.AllowedMentions.none())


@app_commands.command(name="result_help", description="How to submit hockey screenshots and edit a BO3 result.")
@app_commands.guild_only()
async def help_command(interaction: discord.Interaction):
    await interaction.response.send_message(
        "`/result blue_team:BE red_team:RH game1:[image] game2:[image] round:2`\n"
        "Away = Blue. Home = Red. Add game3 after a 1–1 split.\n"
        "Check the preview, then **Confirm & post**. The result posts here.\n\n"
        "`/result_show match:BE vs RH round:2` shows a saved result.", ephemeral=True)


def main():
    load_dotenv()
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    token = os.getenv("DISCORD_TOKEN", "").strip()
    if not token or token == "paste_your_discord_bot_token_here":
        raise SystemExit("Set DISCORD_TOKEN in .env first. See README.md; keep the token private.")
    try:
        client = ResultClient()
        client.run(token, log_handler=None)
    except (ValueError, OCRFailure) as exc:
        raise SystemExit(str(exc)) from exc
    except discord.LoginFailure:
        raise SystemExit("Discord rejected the bot token. Copy the Bot token again into .env.") from None


if __name__ == "__main__":
    main()
