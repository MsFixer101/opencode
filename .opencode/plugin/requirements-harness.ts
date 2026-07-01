// Requirements Harness — an OpenCode plugin that reviews the just-finished turn
// against the user's request, using a decorrelated model (GLM via Ollama) as a PM reviewer.
// Port of ~/.claude/hooks/requirements-harness.mjs (a Claude Code Stop hook).
//
// Claude Code's Stop hook can BLOCK and force the model to continue. OpenCode's `event`
// hook is a passive listener — it cannot freeze a turn. So instead of blocking, on a BLOCK
// verdict we INJECT the review as a new turn via client.session.prompt, which makes the
// agent address it. Same outcome, different mechanism.
//
// SAFETY: fail-open everywhere. Any error / timeout / unreachable model => do nothing.
// Never wedge a session. A loop guard (max 2 injections per genuine user message) and an
// in-flight guard replace the Stop hook's stop_hook_active flag.
import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MODEL = "glm-5.1:cloud"
const LOG = path.join(os.homedir(), ".claude", "hooks", "requirements-harness.log")
const SENTINEL = "[Requirements harness — GLM review]"
const MAX_INJECTIONS = 2

function log(s: string) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${s}\n`)
  } catch {}
}

async function glm(prompt: string): Promise<string> {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 45000)
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({ model: MODEL, prompt, stream: false, think: true }),
    })
    const j: any = await res.json()
    return (j && j.response) || ""
  } finally {
    clearTimeout(to)
  }
}

// Verbatim from requirements-harness.mjs — this rubric is tuned; do not paraphrase.
const RUBRIC = `You are a PM requirements reviewer. An assistant has just responded to a user. Check the response against the user's request, with skeptical PM eyes.

THE OPERATIVE REQUEST is the user's MOST RECENT instruction. If it is a short line sitting inside a large pasted block (logs, terminal output, code), THAT short line is the ask — treat the bulky pasted content as context, not the request. A later instruction overrides an earlier one; use EARLIER CONTEXT only to read intent and re-prioritisation.

PROPORTIONALITY — scale strictness to stakes:
- LOW stakes (saving / moving / writing a doc, log, note, markdown, or config; a trivial edit): do NOT block for "no plan" or for "not a real change". If it did what was asked, PASS.
- HIGH stakes (app logic, data, schema, user-facing behaviour) or any completion claim: apply the full checks.

Checks:
1. INTENT: did the assistant correctly infer the operative request, including the literal verb/ask? Misread => BLOCK.
2. SATISFACTION: does the response/work actually address and satisfy that request? Adjacent / partial / wrong-thing => BLOCK.
3. CHANGE+PLAN: for a SUBSTANTIVE change only, did the assistant present a plan before acting (PLAN MODE USED = yes)? A plan is NOT expected for docs / saves / trivial edits. Charging into a substantive change with no plan => BLOCK.
4. DONE+EVIDENCE: if it claims done, is it backed by real evidence that exercises the real surface (rendered / measured), NOT a circular self-test and NOT bare assertion? Unsupported => BLOCK.

BIAS — default to PASS. Only BLOCK when the problem is clear AND consequential: a wrong thing built, an unsupported "done" on real work, or a substantive misread of the ask. Do NOT block on tone, phrasing, mid-action narration, a response that trails off, or low-stakes session admin (wrap / document / save / move / log / commit) that plausibly did what was asked. When genuinely unsure, PASS.

Output: FIRST LINE exactly PASS or BLOCK. Then 2-4 sentences naming the specific issue.`

type Entry = { role: string; kind: "text" | "tool_use" | "tool_result"; text: string; id: string; name?: string }

// Rebuild a Claude-Code-style timeline from OpenCode messages (info + parts).
function timeline(messages: Array<{ info: any; parts: any[] }>): Entry[] {
  const tl: Entry[] = []
  for (const m of messages) {
    const role = m?.info?.role
    const id = m?.info?.id || ""
    if (!role || !Array.isArray(m.parts)) continue
    for (const p of m.parts) {
      if (p.type === "text" && typeof p.text === "string") {
        tl.push({ role, kind: "text", text: p.text, id })
      } else if (p.type === "tool") {
        const name = p.tool || ""
        const st = p.state || {}
        const input = st.input ? JSON.stringify(st.input).slice(0, 300) : ""
        tl.push({ role, kind: "tool_use", text: `${name}: ${input}`, id, name })
        if (st.status === "completed" && typeof st.output === "string") {
          tl.push({ role, kind: "tool_result", text: String(st.output || ""), id })
        }
      }
    }
  }
  return tl
}

// per-session loop/in-flight state (in-memory; replaces stop_hook_active)
const state = new Map<string, { userKey: string; injections: number; inflight: boolean }>()

const EDIT_TOOLS = /^(edit|write|multiedit|apply_patch)$/
const DONE_RE = /\b(done|fixed|working|shipped|complete|verified|resolved|ready)\b/i

async function review(client: any, sessionID: string) {
  const st = state.get(sessionID) || { userKey: "", injections: 0, inflight: false }
  if (st.inflight) {
    log("inflight, skip")
    return
  }

  let messages: Array<{ info: any; parts: any[] }>
  try {
    const r: any = await client.session.messages({ path: { id: sessionID } })
    messages = r?.data ?? r
    if (!Array.isArray(messages)) {
      log("no messages array, pass")
      return
    }
  } catch (e: any) {
    log("messages fetch fail, pass: " + (e && e.message))
    return
  }

  const tl = timeline(messages)

  // genuine user prompts: not empty, not a system-reminder (<...), not our own injection
  const userIdxs: number[] = []
  for (let i = 0; i < tl.length; i++) {
    const e = tl[i]
    const t = e.text.trim()
    if (e.role === "user" && e.kind === "text" && t && !t.startsWith("<") && !t.startsWith(SENTINEL)) userIdxs.push(i)
  }
  if (!userIdxs.length) {
    log("no request, pass")
    return
  }
  const reqIdx = userIdxs[userIdxs.length - 1]
  const userKey = tl[reqIdx].id || String(reqIdx)
  const LATEST = tl[reqIdx].text
  const EARLIER = userIdxs.slice(-3, -1).map((i) => tl[i].text.replace(/\s+/g, " ").trim().slice(0, 400))
  const turn = tl.slice(reqIdx + 1)

  // loop guard: reset the counter when a new genuine user message appears
  if (st.userKey !== userKey) {
    st.userKey = userKey
    st.injections = 0
  }
  if (st.injections >= MAX_INJECTIONS) {
    state.set(sessionID, st)
    log(`injection cap reached for userKey=${userKey}, pass`)
    return
  }

  // cheap gate (no model call): only review turns that made a file change OR claimed done
  const madeEdit = turn.some((x) => x.kind === "tool_use" && EDIT_TOOLS.test(x.name || ""))
  const lastAsst = [...turn].reverse().find((x) => x.role === "assistant" && x.kind === "text" && x.text.trim())
  const claim = lastAsst ? lastAsst.text : ""
  const claimsDone = DONE_RE.test(claim)
  if (!madeEdit && !claimsDone) {
    log("conversational turn (no edit/claim), pass")
    return
  }
  if (!claim) {
    log("no assistant text, pass")
    return
  }

  const planUsed = turn.some((x) => x.kind === "tool_use" && /plan_enter|plan_exit/.test(x.name || ""))
  const evidence = turn
    .filter((x) => x.kind === "tool_use" || x.kind === "tool_result")
    .map((x) => (x.kind === "tool_use" ? "[CMD] " : "[OUT] ") + x.text.replace(/\s+/g, " ").trim().slice(0, 400))
    .slice(-8)
    .join("\n")

  const op = LATEST.trim().length <= 1200 ? LATEST.trim() : LATEST.trim().slice(0, 500) + "\n…[pasted bulk elided]…\n" + LATEST.trim().slice(-700)
  const earlierBlock = EARLIER.length ? EARLIER.map((t, i) => `(${i + 1}) ${t}`).join("\n") : "(none)"
  const prompt = `${RUBRIC}\n\nMOST RECENT INSTRUCTION (the operative ask — satisfy THIS; the real instruction may be a short line inside pasted bulk):\n${op}\n\nEARLIER CONTEXT (recent prior messages; a later instruction overrides an earlier one):\n${earlierBlock}\n\nPLAN MODE USED THIS TURN: ${planUsed ? "yes" : "no"}\n\nEVIDENCE THE ASSISTANT GATHERED:\n${evidence.slice(0, 2500)}\n\nASSISTANT'S RESPONSE / CLAIM:\n${claim.slice(0, 1500)}`

  st.inflight = true
  state.set(sessionID, st)
  let out = ""
  try {
    out = (await glm(prompt)).trim()
  } catch (e: any) {
    log("glm error, fail-open pass: " + (e && e.message))
    st.inflight = false
    state.set(sessionID, st)
    return
  }
  st.inflight = false
  if (!out) {
    state.set(sessionID, st)
    log("empty glm response, pass")
    return
  }
  const verdict = out.split("\n")[0].trim().toUpperCase()
  log(`verdict=${verdict} | ${out.replace(/\s+/g, " ").slice(0, 300)}`)

  if (verdict.startsWith("BLOCK")) {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: `${SENTINEL}\n${out}` }] },
      })
      st.injections += 1
      log(`injected review (injections=${st.injections})`)
    } catch (e: any) {
      log("inject fail, fail-open: " + (e && e.message))
    }
  }
  state.set(sessionID, st)
}

export const RequirementsHarness: Plugin = async ({ client }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = (event as any).properties?.sessionID
      if (!sessionID) return
      try {
        await review(client, sessionID)
      } catch (e: any) {
        log("uncaught, fail-open: " + (e && e.message))
      }
    },
  }
}
