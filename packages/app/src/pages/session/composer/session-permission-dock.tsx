import { For, Show } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

function DiffPreview(props: { diff: string }) {
  const lines = () =>
    props.diff
      .split("\n")
      .filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "))
      .slice(0, 200)

  const lineStyle = (line: string): Record<string, string> => {
    if (line.startsWith("+"))
      return {
        color: "var(--icon-diff-add-base)",
        "background-color": "color-mix(in srgb, var(--icon-diff-add-base) 10%, transparent)",
        display: "block",
      }
    if (line.startsWith("-"))
      return {
        color: "var(--icon-diff-delete-base)",
        "background-color": "color-mix(in srgb, var(--icon-diff-delete-base) 10%, transparent)",
        display: "block",
      }
    if (line.startsWith("@@"))
      return { color: "var(--text-subtle-base)", opacity: "0.8", display: "block" }
    return { display: "block" }
  }

  return (
    <pre
      style={{
        "max-height": "220px",
        "overflow-y": "auto",
        "font-size": "11px",
        "line-height": "1.4",
        margin: "0",
        padding: "6px 8px",
        "border-radius": "6px",
        "background-color": "var(--surface-raised-stronger-non-alpha)",
        "white-space": "pre",
        "overflow-x": "auto",
      }}
    >
      <For each={lines()}>
        {(line) => <span style={lineStyle(line)}>{line || " "}</span>}
      </For>
    </pre>
  )
}

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="secondary"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={typeof props.request.metadata?.diff === "string" && (props.request.metadata.diff as string).length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div style={{ width: "100%", "overflow-x": "hidden" }}>
            <DiffPreview diff={props.request.metadata.diff as string} />
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
