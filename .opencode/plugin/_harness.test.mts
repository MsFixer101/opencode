// Integration test for requirements-harness.ts — mock OpenCode client + REAL GLM.
// Run: ~/.bun/bin/bun run .opencode/plugin/_harness.test.mts
// Proves: timeline rebuild, cheap gate, BLOCK->inject, PASS->no-inject, loop-guard cap.
import { RequirementsHarness } from "./requirements-harness.ts"

function msg(role: string, id: string, parts: any[]) {
  return { info: { role, id }, parts }
}
function text(t: string) {
  return { type: "text", text: t }
}
function toolEdit(tool: string, output = "ok") {
  return { type: "tool", tool, state: { status: "completed", input: { file: "auth.ts" }, output } }
}

// mock client: messages() returns whatever we set; prompt() records injections
function mockClient(messages: any[]) {
  const injected: string[] = []
  return {
    injected,
    session: {
      async messages() {
        return { data: messages }
      },
      async prompt(opts: any) {
        injected.push(opts.body.parts[0].text)
        return { data: { info: {}, parts: [] } }
      },
    },
  }
}

async function fire(client: any, sessionID = "ses_test") {
  const hooks = await RequirementsHarness({ client } as any)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as any })
}

let pass = 0
let fail = 0
function assert(cond: boolean, label: string, detail = "") {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}  ${detail}`)
  }
}

// ── Case 1: substantive change + false "done", no evidence → expect BLOCK (inject) ──
{
  console.log("\nCase 1: false 'done' on a real bug fix (expect BLOCK → inject)")
  const messages = [
    msg("user", "u1", [text("the login auth is broken, users with valid passwords get rejected. fix it.")]),
    msg("assistant", "a1", [toolEdit("edit"), text("Done — fixed the auth bug. Users can log in now.")]),
  ]
  const c = mockClient(messages)
  await fire(c)
  assert(c.injected.length === 1, "injected exactly once on BLOCK", `got ${c.injected.length}`)
  if (c.injected[0]) console.log("    verdict text: " + c.injected[0].replace(/\s+/g, " ").slice(0, 160))
}

// ── Case 2: low-stakes doc save → expect PASS (no inject) ──
{
  console.log("\nCase 2: low-stakes doc save (expect PASS → no inject)")
  const messages = [
    msg("user", "u1", [text("save today's actions log to docs/")]),
    msg("assistant", "a1", [toolEdit("write", "wrote docs/actions-log_2026-06-19.md"), text("Saved the actions log to docs/.")]),
  ]
  const c = mockClient(messages)
  await fire(c)
  assert(c.injected.length === 0, "no inject on low-stakes save", `got ${c.injected.length}`)
}

// ── Case 3: conversational turn, no edit, no done-claim → cheap gate skips (no GLM, no inject) ──
{
  console.log("\nCase 3: pure conversational turn (expect cheap-gate skip, no inject)")
  const messages = [
    msg("user", "u1", [text("what does this function do?")]),
    msg("assistant", "a1", [text("It validates the session token and returns the user id.")]),
  ]
  const c = mockClient(messages)
  await fire(c)
  assert(c.injected.length === 0, "no inject on conversational turn", `got ${c.injected.length}`)
}

// ── Case 4: loop guard — same user message, BLOCK repeatedly → cap at 2 injections ──
{
  console.log("\nCase 4: loop guard (expect cap at 2 injections for same user message)")
  const messages = [
    msg("user", "u1", [text("the login auth is broken, users with valid passwords get rejected. fix it.")]),
    msg("assistant", "a1", [toolEdit("edit"), text("Done — fixed it.")]),
  ]
  const c = mockClient(messages)
  await fire(c) // 1
  await fire(c) // 2
  await fire(c) // 3 — should be capped
  await fire(c) // 4 — should be capped
  assert(c.injected.length <= 2, "injections capped at 2 for same user message", `got ${c.injected.length}`)
}

console.log(`\n──────── ${pass} passed, ${fail} failed ────────`)
process.exit(fail ? 1 : 0)
