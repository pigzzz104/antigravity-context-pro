#!/usr/bin/env python3
"""Context window usage report for Antigravity 2.0 conversations.

A port of the agy CLI `/context` command (cli/model.ContextModel in agy 1.4.4).
The CLI reads the live trajectory from memory; this script reads the same
protobufs from the conversation database (`steps` and `gen_metadata` tables).
"""

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from urllib.parse import unquote, urlparse

# --- protobuf ----------------------------------------------------------------


def read_varint(buf: bytes, pos: int) -> tuple[int, int]:
    val = 0
    shift = 0
    while pos < len(buf):
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, pos
        shift += 7
    raise ValueError("Truncated varint")


class Msg:
    """Lazily decoded protobuf message: field number -> list of raw values."""

    def __init__(self, buf: bytes | None):
        self.fields: dict[int, list] = {}
        pos, n = 0, len(buf or b"")
        while pos < n:
            try:
                tag, pos = read_varint(buf, pos)
                fn, wt = tag >> 3, tag & 7
                if wt == 0:
                    val, pos = read_varint(buf, pos)
                elif wt == 2:
                    ln, pos = read_varint(buf, pos)
                    val = buf[pos : pos + ln]
                    pos += ln
                elif wt == 1:
                    val, pos = buf[pos : pos + 8], pos + 8
                elif wt == 5:
                    val, pos = buf[pos : pos + 4], pos + 4
                else:
                    break
            except ValueError:
                break
            self.fields.setdefault(fn, []).append(val)

    def has(self, fn: int) -> bool:
        return fn in self.fields

    def int(self, fn: int, signed32: bool = False) -> int:
        v = self.fields.get(fn, [0])[-1]
        v = v if isinstance(v, int) else 0
        if signed32 and v >= 1 << 63:
            v -= 1 << 64
        return v

    def bytes(self, fn: int) -> bytes:
        v = self.fields.get(fn, [b""])[-1]
        return v if isinstance(v, bytes) else b""

    def str(self, fn: int) -> str:
        return self.bytes(fn).decode("utf-8", errors="replace")

    def msg(self, fn: int) -> "Msg | None":
        return Msg(self.bytes(fn)) if self.has(fn) else None

    def msgs(self, fn: int) -> list["Msg"]:
        return [Msg(v) for v in self.fields.get(fn, []) if isinstance(v, bytes)]


# CortexStep oneof payload field numbers.
STEP_VIEW_FILE = 14
STEP_USER_INPUT = 19
STEP_PLANNER_RESPONSE = 20
STEP_CHECKPOINT = 30
STEP_CODE_ACTION = 10

STATUS_DONE = 3

# TokenType values of TopLevelTokenGroup.type.
TOKEN_SYSTEM_PROMPT, TOKEN_TOOLS, TOKEN_RULES, TOKEN_MCP_TOOLS, TOKEN_SKILLS = 1, 2, 3, 4, 5
TOKEN_SUBAGENTS, TOKEN_CHAT_MESSAGES, TOKEN_WORKFLOWS, TOKEN_PLUGINS, TOKEN_FLOWS = 6, 7, 8, 9, 10

# CortexStepType names (exa.cortex_pb), used to parse "N: TYPE" chat item names.
STEP_TYPES = {
    "UNSPECIFIED": 0, "DUMMY": 1, "FINISH": 2, "PLAN_INPUT": 3, "MQUERY": 4, "CODE_ACTION": 5,
    "GIT_COMMIT": 6, "GREP_SEARCH": 7, "VIEW_FILE": 8, "LIST_DIRECTORY": 9, "COMPILE": 10,
    "VIEW_CODE_ITEM": 13, "USER_INPUT": 14, "PLANNER_RESPONSE": 15, "ERROR_MESSAGE": 17,
    "RUN_COMMAND": 21, "CHECKPOINT": 23, "PROPOSE_CODE": 24, "FIND": 25, "SUGGESTED_RESPONSES": 27,
    "COMMAND_STATUS": 28, "MEMORY": 29, "READ_URL_CONTENT": 31, "VIEW_CONTENT_CHUNK": 32,
    "SEARCH_WEB": 33, "RETRIEVE_MEMORY": 34, "MCP_TOOL": 38, "MANAGER_FEEDBACK": 39,
    "TOOL_CALL_PROPOSAL": 40, "TOOL_CALL_CHOICE": 41, "TRAJECTORY_CHOICE": 42, "CLIPBOARD": 45,
    "VIEW_FILE_OUTLINE": 47, "POST_PR_REVIEW": 49, "LIST_RESOURCES": 51, "READ_RESOURCE": 52,
    "LINT_DIFF": 53, "FIND_ALL_REFERENCES": 54, "BRAIN_UPDATE": 55, "OPEN_BROWSER_URL": 56,
    "RUN_EXTENSION_CODE": 57, "PROPOSAL_FEEDBACK": 59, "TRAJECTORY_SEARCH": 60,
    "EXECUTE_BROWSER_JAVASCRIPT": 61, "LIST_BROWSER_PAGES": 62, "CAPTURE_BROWSER_SCREENSHOT": 63,
    "CLICK_BROWSER_PIXEL": 64, "READ_TERMINAL": 65, "CAPTURE_BROWSER_CONSOLE_LOGS": 66,
    "READ_BROWSER_PAGE": 67, "BROWSER_GET_DOM": 68, "CODE_SEARCH": 73, "BROWSER_INPUT": 74,
    "BROWSER_MOVE_MOUSE": 75, "BROWSER_SELECT_OPTION": 76, "BROWSER_SCROLL_UP": 77,
    "BROWSER_SCROLL_DOWN": 78, "BROWSER_CLICK_ELEMENT": 79, "BROWSER_PRESS_KEY": 80,
    "TASK_BOUNDARY": 81, "NOTIFY_USER": 82, "CODE_ACKNOWLEDGEMENT": 83, "INTERNAL_SEARCH": 84,
    "BROWSER_SUBAGENT": 85, "FILE_CHANGE": 86, "MOVE": 87, "BROWSER_SCROLL": 88,
    "KNOWLEDGE_GENERATION": 89, "EPHEMERAL_MESSAGE": 90, "GENERATE_IMAGE": 91,
    "DELETE_DIRECTORY": 92, "COMPILE_APPLET": 93, "INSTALL_APPLET_DEPENDENCIES": 94,
    "INSTALL_APPLET_PACKAGE": 95, "BROWSER_RESIZE_WINDOW": 96, "BROWSER_DRAG_PIXEL_TO_PIXEL": 97,
    "CONVERSATION_HISTORY": 98, "KNOWLEDGE_ARTIFACTS": 99, "SEND_COMMAND_INPUT": 100,
    "SYSTEM_MESSAGE": 101, "WAIT": 102, "AGENCY_TOOL_CALL": 103, "CIDER_AGENT_DUMMY": 104,
    "BUILD_CLEANER": 105, "BLAZE_BUILD_TARGETS": 106, "BLAZE_TEST_TARGETS": 107,
    "SET_UP_FIREBASE": 108, "MOMA": 109, "RESTART_DEV_SERVER": 110, "DEPLOY_FIREBASE": 111,
    "SHELL_EXEC": 112, "BROWSER_MOUSE_WHEEL": 113, "LINT_APPLET": 114, "KI_INSERTION": 116,
    "RETRIEVE_CONTENT": 117, "CRITIQUE": 118, "FINDINGS": 119, "BROWSER_MOUSE_UP": 120,
    "BROWSER_MOUSE_DOWN": 121, "WORKSPACE_API": 122, "BROWSER_LIST_NETWORK_REQUESTS": 123,
    "BROWSER_GET_NETWORK_REQUEST": 124, "BROWSER_REFRESH_PAGE": 125, "EDIT_NOTEBOOK": 126,
    "INVOKE_SUBAGENT": 127, "WRITE_BLOB": 128, "READ_NOTEBOOK": 129, "PROPOSE_AI_COMMENTS": 130,
    "START_CODE_REVIEW": 131, "GENERIC": 132, "SET_UP_CLOUD_SQL": 133, "EXECUTE_NOTEBOOK": 134,
    "CLOUD_SQL_UPDATE_SCHEMA": 135, "RPC_ACTION": 136, "CLOUD_SQL_EXECUTE_SQL": 137,
    "ASK_QUESTION": 138, "DIRECTORY_RULES": 139, "TOOL_SEARCH": 140,
}

CAT_USER, CAT_AGENT, CAT_TOOL, CAT_CHECKPOINT, CAT_SYSTEM = 0, 1, 2, 3, 4

# --- formatting --------------------------------------------------------------


def fmt_tok(n: int) -> str:
    if n >= 1_000_000:
        v = n / 1_000_000.0
        return f"{v:.0f}M" if v.is_integer() else f"{v:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000.0:.1f}k"
    return str(n)


def fmt_ctx_limit(n: int) -> str:
    return fmt_tok(n)


def go_div4(n: int) -> int:
    """Go's int division by 4 (truncates toward zero)."""
    return int(n / 4)


def shorten_path(uri: str) -> str:
    p = uri
    if p.startswith("file:"):
        parsed = urlparse(p)
        p = unquote(parsed.path)
        if len(p) > 2 and p[0] == "/" and p[2] == ":":
            p = p[1:]
    home = str(Path.home())
    p = p.replace("\\", "/")
    home = home.replace("\\", "/")
    if p.startswith(home):
        return "~" + p[len(home) :]
    return p


# --- stats (model.ContextModel.collectStats) ---------------------------------


def step_category(step_type: int) -> int:
    if step_type == 14:
        return CAT_USER
    if step_type == 15:
        return CAT_AGENT
    if step_type == 23:
        return CAT_CHECKPOINT
    if step_type in (0, 2, 101):
        return CAT_SYSTEM
    return CAT_TOOL


STEP_GENERIC = 140
GENERIC_TYPE = 132
ORIGINAL_STEP_TYPE_URL = "/gemini_coder.Step"


def packed_original_step(generic: Msg) -> bytes | None:
    """The typed step a GENERIC step wraps (rehydration.originalStepAny)."""
    result = generic.msg(2)
    if result is None:
        return None
    payload = result.msg(6)
    if payload is not None and payload.str(1).endswith(ORIGINAL_STEP_TYPE_URL):
        return payload.bytes(2)
    for entry in result.msgs(5):
        if entry.str(1) == "__original_cortex_step":
            value = entry.msg(2)
            if value is not None and value.str(1).endswith(ORIGINAL_STEP_TYPE_URL):
                return value.bytes(2)
    return None


def is_skill_file(path: str) -> bool:
    return path.replace("\\", "/").endswith("/SKILL.md")


class Step:
    def __init__(self, pos: int, payload: bytes, step_type: int, status: int, metadata: bytes | None):
        self.pos = pos
        self.pb = Msg(payload)
        self.type = self.pb.int(1) if self.pb.has(1) else step_type
        self.status = self.pb.int(4) if self.pb.has(4) else status
        self.md = self.pb.msg(5) or Msg(metadata)
        self.view_file_override: Msg | None = None
        if self.type == GENERIC_TYPE:
            self.rehydrate()

    def rehydrate(self):
        """Turn a GENERIC tool step back into its typed step, like the CLI's rehydration.RehydrateStep."""
        generic = self.pb.msg(STEP_GENERIC)
        if generic is None:
            return
        original = packed_original_step(generic)
        if original is not None:
            self.pb = Msg(original)
            self.type = self.pb.int(1)
            self.md = self.pb.msg(5) or Msg(b"")
            return
        tc = self.md.msg(4)
        if tc is None or tc.str(2) not in ("view_file", "read_file"):
            return
        try:
            args = json.loads(tc.str(3) or "{}")
        except json.JSONDecodeError:
            return
        path = next((args[k] for k in ("AbsolutePath", "Path", "FilePath") if isinstance(args.get(k), str) and args[k]), "")
        if path:
            self.type = 8  # VIEW_FILE
            self.view_file_override = Msg(
                b"\x0a" + _varint(len(path.encode())) + path.encode() + (b"\x88\x01\x01" if is_skill_file(path) else b"")
            )

    def payload(self, fn: int) -> Msg | None:
        if fn == STEP_VIEW_FILE and self.view_file_override is not None:
            return self.view_file_override
        return self.pb.msg(fn)


def _varint(n: int) -> bytes:
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def estimate_step_tokens(step: Step) -> int:
    ui = step.payload(STEP_USER_INPUT)
    pr = step.payload(STEP_PLANNER_RESPONSE)
    if ui is not None:
        n = len(ui.bytes(2))  # user_response
    elif pr is not None:
        n = len(pr.bytes(1))  # response
    else:
        tc = step.md.msg(4)  # tool_call
        n = len(tc.bytes(3)) if tc else 0  # arguments_json
        out = step.md.int(23, signed32=True)  # tool_call_output_tokens
        if out > 0:
            return out
        gen = step.pb.msg(STEP_GENERIC)
        res = gen.msg(2) if gen is not None else None
        if res is not None and len(res.bytes(1)) > 0:
            n += len(res.bytes(1))
    if n == 0:
        return 0
    return max(1, go_div4(n))


def step_tokens(step: Step) -> int:
    usage = step.md.msg(9)  # model_usage
    if usage is not None:
        return usage.int(3)  # output_tokens
    return estimate_step_tokens(step)


def compaction_tokens(step: Step) -> int:
    for ri in reversed(step.md.msgs(28)):  # retry_infos
        usage = ri.msg(2)
        if usage is None:
            continue
        resp = usage.int(10)
        if resp:
            return resp
        out, thinking = usage.int(3), usage.int(9)
        return out - thinking if thinking < out else 0
    return 0


def checkpoint_summary_tokens(step: Step) -> int:
    t = compaction_tokens(step)
    if t:
        return t
    ck = step.payload(STEP_CHECKPOINT) or Msg(b"")
    return go_div4(len(ck.bytes(4)) + len(ck.bytes(5)) + len(ck.bytes(6)))


def checkpoint_newer_than_generation(steps: list[Step], chat_start: Msg | None) -> tuple[int, Step | None]:
    i = len(steps) - 1
    while i >= 0:
        s = steps[i]
        if s.payload(STEP_CHECKPOINT) is not None and s.status == STATUS_DONE:
            break
        i -= 1
    if i < 0:
        return -1, None
    for s in steps[i + 1 :]:
        if s.payload(STEP_PLANNER_RESPONSE) is not None and s.status == STATUS_DONE:
            return -1, None
    gen_ck = chat_start.int(2, signed32=True) if chat_start is not None else -1
    ck_idx = steps[i].payload(STEP_CHECKPOINT).int(1)
    if gen_ck >= ck_idx:
        return -1, None
    return i, steps[i]


def chat_tokens_by_category(items: list[Msg]) -> tuple[bool, list[int]]:
    out = [0, 0, 0, 0]  # user, agent, tool, system
    if not items:
        return False, out
    for it in items:
        left, sep, right = it.str(1).partition(": ")
        if not sep or not re.fullmatch(r"[+-]?[0-9]+", left) or right not in STEP_TYPES:
            return False, [0, 0, 0, 0]
        cat = step_category(STEP_TYPES[right])
        tok = it.int(3, signed32=True)
        if cat == CAT_USER:
            out[0] += tok
        elif cat in (CAT_AGENT, CAT_CHECKPOINT):
            out[1] += tok
        elif cat == CAT_TOOL:
            out[2] += tok
        else:
            out[3] += tok
    return True, out


def detect_system_files(home: str, workspace: str | None, app_dir: str) -> list[tuple[str, int]]:
    if not home:
        return []
    gemini = Path(home) / ".gemini"
    disp = "~/" + gemini.name
    found = []
    f = gemini / "GEMINI.md"
    if f.exists() and not f.is_dir():
        found.append(disp + "/GEMINI.md")
    for sub in ("skills", "rules", "agents", "global_workflows"):
        if (gemini / sub).is_dir():
            found.append(f"{disp}/{sub}/")
    if app_dir:
        for sub in ("rules", "skills", "agents", "global_workflows"):
            if (gemini / app_dir / sub).is_dir():
                found.append(f"{disp}/{app_dir}/{sub}/")
    if workspace:
        for root in (".agents", "_agents"):
            for sub in ("rules", "skills", "agents", "workflows"):
                if (Path(workspace) / root / sub).is_dir():
                    found.append(f"{root}/{sub}/")
            hooks = Path(workspace) / root / "hooks.json"
            if hooks.exists() and not hooks.is_dir():
                found.append(f"{root}/hooks.json")
    return [(p, 0) for p in found]


def collect_stats(steps: list[Step], gen: Msg | None, limit: int) -> dict:
    st = {k: 0 for k in (
        "user", "agent", "tool", "checkpoint", "system_messages", "system_prompt", "system_tools",
        "system_overhead", "rules", "skills", "subagents", "legacy_workflows", "workflows",
        "plugins", "mcp_tools",
    )}
    st["has_breakdown"] = False
    st["active_checkpoint"] = -1
    checkpoints, knowledge, artifacts, skill_files = [], [], [], []
    seen_k, seen_a, seen_s = set(), set(), set()

    chat = gen.msg(1) if gen is not None else None
    chat_start = chat.msg(9) if chat is not None else None
    newer_pos, newer_step = checkpoint_newer_than_generation(steps, chat_start)
    has_newer = newer_step is not None
    st["compacted"] = has_newer

    for pos, step in enumerate(steps):
        cat = step_category(step.type)
        tok = step_tokens(step)
        counted = 0 if has_newer and newer_pos > pos else tok
        if cat == CAT_USER:
            st["user"] += counted
        elif cat == CAT_AGENT:
            st["agent"] += counted
        elif cat == CAT_TOOL:
            st["tool"] += counted
        elif cat == CAT_CHECKPOINT:
            st["checkpoint"] += tok
            ck = step.payload(STEP_CHECKPOINT)
            if ck is not None:
                checkpoints.append({
                    "index": ck.int(1),
                    "start": ck.int(11),
                    "end": ck.int(12),
                    "intent": ck.str(4),
                })
        else:
            st["system_messages"] += counted

        ca = step.payload(STEP_CODE_ACTION)
        result = ca.msg(2) if ca is not None else None
        edit = result.msg(1) if result is not None else None
        if edit is not None:
            uri = edit.str(8)  # absolute_uri
            short = shorten_path(uri)
            if ca.int(21) and uri not in seen_a:  # is_artifact_file
                seen_a.add(uri)
                artifacts.append((short, tok))
            if ca.int(24) and uri not in seen_k:  # is_knowledge_file
                seen_k.add(uri)
                knowledge.append((short, tok))

        vf = step.payload(STEP_VIEW_FILE)
        if vf is not None and vf.int(17):  # is_skill_file
            uri = vf.str(1)
            if uri not in seen_s:
                seen_s.add(uri)
                skill_files.append((shorten_path(uri), tok))

    cwm = chat_start.msg(10) if chat_start is not None else None
    breakdown = cwm.msg(3) if cwm is not None else None
    if breakdown is not None:
        st["has_breakdown"] = True
        seen_prompt = seen_tools = False
        chat_tok, chat_items = 0, []
        for g in breakdown.msgs(1):
            gtype, gtok = g.int(2), g.int(4, signed32=True)
            if gtype == TOKEN_SYSTEM_PROMPT:
                extracted = 0
                for child in g.msgs(5):
                    name, ctok = child.str(1), child.int(3, signed32=True)
                    if name == "flows":
                        st["workflows"] += ctok
                    elif name == "skills":
                        st["skills"] += ctok
                    elif name == "subagents":
                        st["subagents"] += ctok
                    else:
                        continue
                    extracted += ctok
                st["system_prompt"] = gtok - extracted
                seen_prompt = True
            elif gtype == TOKEN_TOOLS:
                st["system_tools"] = gtok
                seen_tools = True
            elif gtype == TOKEN_RULES:
                st["rules"] += gtok
            elif gtype == TOKEN_MCP_TOOLS:
                st["mcp_tools"] += gtok
            elif gtype == TOKEN_SKILLS:
                st["skills"] += gtok
            elif gtype == TOKEN_SUBAGENTS:
                st["subagents"] += gtok
            elif gtype == TOKEN_CHAT_MESSAGES:
                chat_tok, chat_items = gtok, g.msgs(5)
            elif gtype == TOKEN_WORKFLOWS:
                st["legacy_workflows"] += gtok
            elif gtype == TOKEN_PLUGINS:
                st["plugins"] += gtok
            elif gtype == TOKEN_FLOWS:
                st["workflows"] += gtok

        if not seen_prompt and not seen_tools and chat_tok:
            usage = chat.msg(4)
            api_input = usage.int(2) + usage.int(5) if usage is not None else 0
            if chat_tok < api_input:
                st["system_overhead"] = api_input - chat_tok

        if chat_tok and not has_newer:
            ok, cats = chat_tokens_by_category(chat_items)
            if ok:
                st["user"], st["agent"], st["tool"], st["system_messages"] = cats
            else:
                est = st["user"] + st["agent"] + st["tool"]
                if est == 0:
                    st["agent"] = chat_tok
                else:
                    f = chat_tok / est
                    st["user"] = int(st["user"] * f)
                    st["agent"] = int(st["agent"] * f)
                    st["tool"] = int(st["tool"] * f)

    if chat_start is not None:
        st["active_checkpoint"] = chat_start.int(2, signed32=True)
    if has_newer:
        st["agent"] += checkpoint_summary_tokens(newer_step)
        st["active_checkpoint"] = newer_step.payload(STEP_CHECKPOINT).int(1)

    st["total"] = sum(st[k] for k in (
        "user", "agent", "tool", "system_messages", "system_prompt", "system_tools", "system_overhead",
        "rules", "skills", "subagents", "legacy_workflows", "workflows", "plugins", "mcp_tools",
    ))
    st["limit"] = limit
    st["checkpoints"] = checkpoints
    st["knowledge_files"] = knowledge
    st["artifact_files"] = artifacts
    st["skill_files"] = skill_files
    return st


# --- rendering ---------------------------------------------------------------

CATEGORIES = [
    ("◉", "User messages", "user", True),
    ("◉", "Agent responses", "agent", True),
    ("◉", "Tool calls", "tool", True),
    ("⛁", "System prompt", "system_prompt", False),
    ("⛁", "System tools", "system_tools", False),
    ("⛁", "System overhead", "system_overhead", False),
    ("⛁", "Rules", "rules", False),
    ("⛁", "Skills", "skills", False),
    ("⛁", "Subagents", "subagents", False),
    ("⛁", "Legacy workflows", "legacy_workflows", False),
    ("⛁", "Workflows", "workflows", False),
    ("⛁", "Plugins", "plugins", False),
    ("⛁", "MCP tools", "mcp_tools", False),
    ("◉", "System messages", "system_messages", False),
]

GRID_COLORS = ["\x1b[90m", "\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[34m", "\x1b[2m"]


def pct(n: int, limit: int) -> float:
    return n / limit * 100.0 if limit else 0.0


def stats_heading(st: dict) -> str:
    if st["compacted"]:
        return "Estimated after compaction · updates next turn"
    if st["has_breakdown"]:
        return "Token usage by category"
    return "Estimated usage (awaiting generation)"


def render_stats(st: dict, model: str) -> str:
    used, limit = st["total"], st["limit"]
    out = []
    if limit:
        out.append(f"{model} · {fmt_tok(used)}/{fmt_ctx_limit(limit)} tokens\n ({min(100.0, pct(used, limit)):.1f}%)\n")
    else:
        out.append(f"{model} · {fmt_tok(used)}/Unknown tokens\n")
    out.append(stats_heading(st) + "\n")
    for icon, name, key, always in CATEGORIES:
        tok = st[key]
        if always or tok:
            out.append(f"{icon} {name}: {fmt_tok(tok)} tokens ({pct(tok, limit):.1f}%)\n")
    free = limit - used if used < limit else 0
    out.append(f"□ Free space: {fmt_tok(free)} ({pct(free, limit):.1f}%)\n")
    if st["checkpoint"]:
        out.append(f"⊠ Checkpoint buffer: {fmt_tok(st['checkpoint'])} tokens (not counted in usage)\n")
    return "".join(out)


def grid_segments(st: dict) -> list[int]:
    """Token totals of the grid's five colored segments, in drawing order."""
    return [
        st["system_prompt"] + st["system_tools"] + st["system_overhead"],
        st["user"],
        st["agent"],
        st["tool"],
        sum(st[k] for k in ("rules", "skills", "subagents", "legacy_workflows", "workflows", "plugins", "mcp_tools")),
    ]


def render_grid(st: dict, width: int, rows: int, color: bool) -> list[str]:
    cols = max(10, width // 2)
    total_cells = max(1, rows) * cols
    limit = st["limit"]
    counts = [0 if not tok or not limit else max(1, int(tok / limit * total_cells)) for tok in grid_segments(st)]
    used = sum(counts)
    if used > total_cells:
        f = total_cells / used
        counts = [int(c * f) for c in counts]
    counts.append(total_cells - sum(counts))

    cells = []
    for i, n in enumerate(counts):
        glyph = "□" if i == 5 else "◉"
        cells.extend([f"{GRID_COLORS[i]}{glyph}\x1b[0m" if color else glyph] * n)
    return [" ".join(cells[r * cols : (r + 1) * cols]) for r in range(len(cells) // cols)]


def checkpoint_view(st: dict) -> dict | None:
    cks = st["checkpoints"]
    if not cks:
        return None
    active, historical = None, 0
    for ck in cks:
        if st["active_checkpoint"] >= 0 and ck["index"] == st["active_checkpoint"]:
            active = ck
        else:
            historical += 1
    if active is None:
        active, historical = cks[-1], len(cks) - 1
    text = active["intent"]
    if len(text.encode()) > 70:
        text = text.encode()[:67].decode("utf-8", errors="ignore") + "..."
    if not text:
        text = f"steps {active['start']}–{active['end']}"
    return {"count": len(cks), "active_number": active["index"] + 1, "active_text": text, "historical": historical}


def render_checkpoints(st: dict) -> str:
    view = checkpoint_view(st)
    if view is None:
        return ""
    out = [
        f"Checkpoints ({view['count']}) · /rewind\n",
        f"└ Checkpoint {view['active_number']} (active, in context): {view['active_text']}\n",
    ]
    if view["historical"]:
        out.append(f"  {view['historical']} historical checkpoint(s) (summarized, not in context)\n")
    return "".join(out)


def render_file_section(title: str, subtitle: str, items: list[tuple[str, int]]) -> str:
    if not items:
        return ""
    out = [f"\n{title} · {subtitle}\n"]
    for path, tok in items:
        out.append(f" └ {path}: {fmt_tok(tok)} tokens\n" if tok > 0 else f" └ {path}\n")
    return "".join(out)


def render(st: dict, model: str, system_files: list[tuple[str, int]], term_width: int, color: bool) -> str:
    stats = render_stats(st, model)
    grid_width = max(20, (2 * term_width) // 5)
    if term_width >= 70 and term_width - grid_width - 6 >= 40:
        grid = render_grid(st, grid_width, max(3, stats.count("\n")), color)
        stat_lines = stats.rstrip("\n").split("\n")
        pad = max(10, grid_width // 2) * 2 - 1
        lines = []
        for i in range(max(len(grid), len(stat_lines))):
            g = grid[i] if i < len(grid) else " " * pad
            s = stat_lines[i] if i < len(stat_lines) else ""
            lines.append(f"{g}   {s}".rstrip())
        body = "\n".join(lines) + "\n"
    else:
        grid = render_grid(st, term_width if term_width >= 20 else 40, 3, color)
        body = stats + "\n" + "\n".join(grid) + "\n"

    parts = ["└ Context Usage\n", "\n", body]
    ck = render_checkpoints(st)
    if ck:
        parts += ["\n", ck]
    parts.append(render_file_section("Knowledge files", "/rules", st["knowledge_files"]))
    parts.append(render_file_section("Artifact files", "/artifact", st["artifact_files"]))
    parts.append(render_file_section("Skill files", "/skill", st["skill_files"]))
    parts.append(render_file_section("System files", "auto-loaded", system_files))
    parts.append("\nRelated: /artifact · /skill · /rewind")
    return "".join(parts)


# --- main --------------------------------------------------------------------


def _dur_ms(m: Msg | None) -> int:
    if m is None:
        return 0
    return round((m.int(1) + m.int(2) / 1e9) * 1000)


STEP_TYPE_NAMES = {v: k for k, v in STEP_TYPES.items()}


def _clean_snippet(text: str, max_len: int = 240) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"</?USER_REQUEST>", "", text).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    if len(cleaned) > max_len:
        return cleaned[: max_len - 1] + "…"
    return cleaned


def _summarize_tool_args(name: str, args_raw: str, step: Step | None = None) -> str:
    try:
        args = json.loads(args_raw or "{}")
        if not isinstance(args, dict):
            args = {}
    except json.JSONDecodeError:
        args = {}

    for k in ("Path", "AbsolutePath", "FilePath", "TargetFile", "DirectoryPath"):
        val = args.get(k)
        if isinstance(val, str) and val.strip():
            short = shorten_path(val.strip())
            sl, el = args.get("StartLine"), args.get("EndLine")
            if sl or el:
                short += f":L{sl or 1}-{el or 'end'}"
            return short

    summary = args.get("toolSummary")
    cmd = args.get("CommandLine")
    if isinstance(summary, str) and summary.strip():
        if isinstance(cmd, str) and cmd.strip():
            first_line = cmd.strip().splitlines()[0][:44]
            return f"{summary.strip()} ({first_line})"
        return summary.strip()
    if isinstance(cmd, str) and cmd.strip():
        return cmd.strip().splitlines()[0][:64]

    for k in ("query", "Query", "SearchTerm", "Pattern", "Url", "Uri", "Role"):
        val = args.get(k)
        if isinstance(val, str) and val.strip():
            return val.strip()[:64]

    queries = args.get("queries")
    if isinstance(queries, list) and queries:
        return ", ".join(str(x) for x in queries[:3])[:64]

    if step is not None:
        vf = step.payload(STEP_VIEW_FILE)
        if vf is not None and vf.str(1):
            return shorten_path(vf.str(1))
        ca = step.payload(STEP_CODE_ACTION)
        res = ca.msg(2) if ca is not None else None
        ed = res.msg(1) if res is not None else None
        if ed is not None and ed.str(8):
            return shorten_path(ed.str(8))

    for v in args.values():
        if isinstance(v, str) and v.strip():
            return v.strip().splitlines()[0][:56]
    return ""


def collect_telemetry(db_path: Path, steps: list[Step] | None = None) -> dict:
    """Extract per-turn and cumulative generation telemetry from gen_metadata + steps."""
    uri = "file:" + db_path.as_posix() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        rows = conn.execute("SELECT idx, data FROM gen_metadata ORDER BY idx ASC").fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        conn.close()

    gm_steps: dict[int, list[tuple[int, Step]]] = {}
    user_by_gm: dict[int, tuple[str, int]] = {}
    if steps:
        pending_user: tuple[str, int] | None = None
        for pos, s in enumerate(steps):
            if s.type == 14:  # USER_INPUT
                ui = s.payload(STEP_USER_INPUT)
                u_txt = _clean_snippet(ui.str(2) if ui is not None else "", 220)
                if u_txt:
                    pending_user = (u_txt, step_tokens(s))
            gm_link = s.md.msg(20)
            if gm_link is not None and gm_link.has(3):
                g_idx = gm_link.int(3)
                gm_steps.setdefault(g_idx, []).append((pos, s))
                if pending_user is not None and g_idx not in user_by_gm:
                    user_by_gm[g_idx] = pending_user
                    pending_user = None

    turns = []
    sum_in = sum_cache = sum_out = sum_think = sum_resp = 0
    sum_ttft = sum_stream = sum_total_ms = 0
    peak_tps = 0.0
    peak_prefill = 0
    prev_prompt_tok = 0

    for idx, blob in rows:
        gm = Msg(blob)
        chat = gm.msg(1)
        if chat is None:
            continue
        u = chat.msg(4)
        if u is None:
            continue
        inp = u.int(2)
        cache = u.int(5)
        prompt_tok = inp + cache
        context_delta = prompt_tok - prev_prompt_tok if prev_prompt_tok > 0 else prompt_tok
        prev_prompt_tok = prompt_tok

        out = u.int(3)
        think = u.int(9)
        resp = u.int(10) or max(0, out - think)
        ttft_ms = _dur_ms(chat.msg(11))
        stream_ms = _dur_ms(chat.msg(12))
        total_ms = ttft_ms + stream_ms
        tps = round(out / (total_ms / 1000.0), 1) if total_ms > 0 else 0.0
        stream_tps = round(resp / (stream_ms / 1000.0), 1) if stream_ms >= 100 else tps
        prefill_tps = round(prompt_tok / (ttft_ms / 1000.0)) if ttft_ms > 0 else 0
        cache_pct = round(cache / prompt_tok * 100.0, 1) if prompt_tok > 0 else 0.0

        sum_in += inp
        sum_cache += cache
        sum_out += out
        sum_think += think
        sum_resp += resp
        sum_ttft += ttft_ms
        sum_stream += stream_ms
        sum_total_ms += total_ms
        if tps > peak_tps:
            peak_tps = tps
        if prefill_tps > peak_prefill:
            peak_prefill = prefill_tps

        linked = gm_steps.get(idx, [])
        pr_entry = next(((p, s) for p, s in linked if s.type == 15), linked[0] if linked else None)
        traj_step = pr_entry[0] if pr_entry else idx
        timestamp = ""
        think_preview = ""
        resp_preview = ""
        tools_list = []

        if pr_entry is not None:
            _, pr_s = pr_entry
            ts_msg = pr_s.md.msg(1)
            if ts_msg is not None and ts_msg.int(1) > 0:
                try:
                    timestamp = datetime.fromtimestamp(ts_msg.int(1)).strftime("%H:%M:%S")
                except (OSError, ValueError):
                    timestamp = ""
            pr_pay = pr_s.payload(STEP_PLANNER_RESPONSE)
            if pr_pay is not None:
                think_preview = _clean_snippet(pr_pay.str(3), 260)
                resp_preview = _clean_snippet(pr_pay.str(1), 260)

        for _, ts_step in linked:
            if ts_step.type in (14, 15):
                continue
            tc = ts_step.md.msg(4)
            tname = tc.str(2) if tc is not None and tc.str(2) else STEP_TYPE_NAMES.get(ts_step.type, f"step_{ts_step.type}").lower()
            targs = tc.str(3) if tc is not None else ""
            ttok = step_tokens(ts_step)
            tsum = _summarize_tool_args(tname, targs, ts_step)
            tools_list.append({
                "name": tname,
                "summary": tsum,
                "tokens": ttok,
            })

        if not tools_list:
            cm = chat.msg(2)
            if cm is not None:
                for tc in cm.msgs(6):
                    tname = tc.str(2)
                    targs = tc.str(3)
                    if tname:
                        tools_list.append({
                            "name": tname,
                            "summary": _summarize_tool_args(tname, targs, None),
                            "tokens": max(1, go_div4(len(tc.bytes(3)))),
                        })

        u_prompt, u_tok = user_by_gm.get(idx, ("", 0))

        turns.append({
            "step": idx,
            "traj_step": traj_step,
            "timestamp": timestamp,
            "input_tokens": inp,
            "cache_read_tokens": cache,
            "prompt_tokens": prompt_tok,
            "context_delta": context_delta,
            "cache_hit_pct": cache_pct,
            "output_tokens": out,
            "thinking_tokens": think,
            "response_tokens": resp,
            "ttft_ms": ttft_ms,
            "stream_ms": stream_ms,
            "total_ms": total_ms,
            "output_tps": tps,
            "stream_tps": stream_tps,
            "prefill_tps": prefill_tps,
            "trace_id": u.str(11),
            "user_prompt": u_prompt,
            "user_tokens": u_tok,
            "thinking_preview": think_preview,
            "response_preview": resp_preview,
            "tools": tools_list,
            "tool_tokens": sum(t["tokens"] for t in tools_list),
        })

    n = len(turns)
    total_prompt_all = sum_in + sum_cache
    avg_tps = round(sum_out / (sum_total_ms / 1000.0), 1) if sum_total_ms > 0 else 0.0
    avg_ttft_ms = round(sum_ttft / n) if n > 0 else 0
    avg_prefill_tps = round(total_prompt_all / (sum_ttft / 1000.0)) if sum_ttft > 0 else 0
    overall_cache_pct = round(sum_cache / total_prompt_all * 100.0, 1) if total_prompt_all > 0 else 0.0

    return {
        "total_calls": n,
        "latest": turns[-1] if turns else None,
        "summary": {
            "sum_input_tokens": sum_in,
            "sum_cache_read_tokens": sum_cache,
            "sum_prompt_tokens": total_prompt_all,
            "overall_cache_hit_pct": overall_cache_pct,
            "sum_output_tokens": sum_out,
            "sum_thinking_tokens": sum_think,
            "sum_response_tokens": sum_resp,
            "sum_ttft_ms": sum_ttft,
            "sum_stream_ms": sum_stream,
            "sum_total_ms": sum_total_ms,
            "avg_ttft_ms": avg_ttft_ms,
            "avg_output_tps": avg_tps,
            "peak_output_tps": peak_tps,
            "avg_prefill_tps": avg_prefill_tps,
            "peak_prefill_tps": peak_prefill,
        },
        "recent_turns": list(reversed(turns[-40:])),
        "turns_curve": [
            {
                "step": t["step"],
                "traj_step": t["traj_step"],
                "prompt_tokens": t["prompt_tokens"],
                "context_delta": t["context_delta"],
                "cache_read_tokens": t["cache_read_tokens"],
                "input_tokens": t["input_tokens"],
                "output_tokens": t["output_tokens"],
                "thinking_tokens": t["thinking_tokens"],
                "cache_hit_pct": t["cache_hit_pct"],
                "timestamp": t["timestamp"],
                "user_prompt": t["user_prompt"],
                "tool_count": len(t["tools"]),
                "tool_summary": ", ".join(x["name"] for x in t["tools"][:2]),
            }
            for t in turns
        ],
    }


def load(db_path: Path) -> tuple[list[Step], Msg | None]:
    uri = "file:" + db_path.as_posix() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        rows = conn.execute("SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx").fetchall()
        steps = [Step(pos, r[4] or b"", r[1], r[2], r[3]) for pos, r in enumerate(rows)]
        row = conn.execute("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1").fetchone()
    finally:
        conn.close()
    return steps, (Msg(row[0]) if row else None)


# Native context windows from the model catalog, which the CLI fetches from the server
# (ModelInfo.max_tokens) and never writes to disk. Matched by model ID prefix; the first
# match wins. Add a row when a new model family ships.
NATIVE_CONTEXT_WINDOWS = [
    ("claude-opus-4-6", 250_000),
    ("claude-sonnet-4-6", 250_000),
    ("claude-", 1_000_000),
    ("gpt-oss-", 131_072),
    ("gemini-", 1_048_576),
]

EFFORT_LEVELS = ("minimal", "low", "medium", "high", "xhigh", "max")
WORD_LABELS = {"gpt": "GPT", "oss": "OSS"}


def model_id(gen: Msg | None) -> str:
    planner = gen.msg(3) if gen is not None else None
    return planner.str(28) if planner is not None else ""  # planner_config.model_name


def model_label(slug: str) -> str:
    """Catalog-style label from a model ID: gemini-3.8-flash-medium -> Gemini 3.8 Flash (Medium)."""
    parts = slug.split("-")
    effort = parts.pop().capitalize() if len(parts) > 1 and parts[-1] in EFFORT_LEVELS else ""
    words: list[str] = []
    for p in parts:
        if p.isdigit() and words and words[-1][-1:].isdigit():
            words[-1] += "." + p  # claude-opus-5-5 -> 5.5
        elif p in WORD_LABELS:
            words.append(WORD_LABELS[p])
        elif p[:1].isdigit():
            words.append(p.upper())  # 120b -> 120B
        else:
            words.append(p.capitalize())
    label = " ".join(words).replace("GPT OSS", "GPT-OSS")
    return f"{label} ({effort})" if effort else label


def model_name(gen: Msg | None) -> str:
    chat = gen.msg(1) if gen is not None else None
    if chat is not None and chat.str(21):  # model_display_name
        return chat.str(21)
    if model_id(gen):
        return model_label(model_id(gen))
    if chat is not None and chat.str(19):  # response_model
        return chat.str(19)
    return "Unknown Model"


def context_limit(gen: Msg | None) -> int:
    """The model's native window, like the CLI; else the request budget (max_context_tokens)."""
    slug = model_id(gen)
    for prefix, tokens in NATIVE_CONTEXT_WINDOWS:
        if slug.startswith(prefix):
            return tokens
    return request_budget(gen)


def request_budget(gen: Msg | None) -> int:
    chat = gen.msg(1) if gen is not None else None
    start = chat.msg(9) if chat is not None else None
    cwm = start.msg(10) if start is not None else None
    return cwm.int(4, signed32=True) if cwm is not None else 0


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Analyze Antigravity 2.0 conversation context usage.")
    parser.add_argument("--conversation-id", help="Conversation UUID (auto-detected if omitted)")
    parser.add_argument("--db", help="Path to a conversation .db file (e.g. one from ~/.gemini/antigravity-cli/conversations)")
    parser.add_argument("--workspace", help="Active workspace path", default=None)
    parser.add_argument("--limit", type=int, default=0, help="Context window token limit override")
    parser.add_argument("--app-dir", default="antigravity", help="App data folder under ~/.gemini (default: antigravity)")
    parser.add_argument("--width", type=int, default=100, help="Terminal width used for the grid layout")
    parser.add_argument("--color", action="store_true", help="Color the grid segments with ANSI escapes")
    parser.add_argument("--json", action="store_true", help="Output JSON data")
    parser.add_argument("--model-catalog", help='JSON file of {"<model id>": {"maxTokens": n, "displayName": "..."}} '
                        "from the app's live model catalog; overrides the built-in limits and labels")
    args = parser.parse_args()

    if args.db:
        db_path = Path(args.db).expanduser()
        conv_id = db_path.stem
    else:
        conv_dir = Path.home() / ".gemini" / "antigravity" / "conversations"
        conv_id = args.conversation_id
        if not conv_id:
            dbs = sorted(conv_dir.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
            if not dbs:
                raise SystemExit("No conversation databases found.")
            conv_id = dbs[0].stem
        db_path = conv_dir / f"{conv_id}.db"
    if not db_path.is_file():
        raise SystemExit(f"Conversation database not found: {db_path}")

    steps, gen = load(db_path)
    catalog_entry = {}
    if args.model_catalog:
        with open(args.model_catalog, encoding="utf-8") as fh:
            catalog_entry = json.load(fh).get(model_id(gen)) or {}
    limit = args.limit if args.limit > 0 else int(catalog_entry.get("maxTokens") or 0) or context_limit(gen)
    st = collect_stats(steps, gen, limit)
    model = catalog_entry.get("displayName") or model_name(gen)
    system_files = detect_system_files(os.path.expanduser("~"), args.workspace, args.app_dir)

    if args.json:
        print(json.dumps({
            "conversation_id": conv_id,
            "model": model,
            "heading": stats_heading(st),
            "grid_segments": grid_segments(st),
            "checkpoint_view": checkpoint_view(st),
            "text": render(st, model, system_files, args.width, False),
            "model_id": model_id(gen),
            "request_budget_tokens": request_budget(gen),
            "used_tokens": st["total"],
            "limit_tokens": limit,
            "used_pct": round(min(100.0, pct(st["total"], limit)), 1),
            "free_tokens": limit - st["total"] if st["total"] < limit else 0,
            "has_breakdown": st["has_breakdown"],
            "compacted": st["compacted"],
            "checkpoint_buffer": st["checkpoint"],
            "categories": [
                {"icon": icon, "name": name, "key": key, "tokens": st[key], "pct": round(pct(st[key], limit), 1)}
                for icon, name, key, always in CATEGORIES
                if always or st[key]
            ],
            "active_checkpoint": st["active_checkpoint"],
            "checkpoints": st["checkpoints"],
            "knowledge_files": [{"path": p, "tokens": t} for p, t in st["knowledge_files"]],
            "artifact_files": [{"path": p, "tokens": t} for p, t in st["artifact_files"]],
            "skill_files": [{"path": p, "tokens": t} for p, t in st["skill_files"]],
            "system_files": [{"path": p} for p, _ in system_files],
            "telemetry": collect_telemetry(db_path, steps),
        }, indent=2))
        return

    print(render(st, model, system_files, args.width, args.color))


if __name__ == "__main__":
    main()
