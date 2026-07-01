import { TextAttributes } from "@opentui/core"
import { createSignal, onCleanup, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useKeyboard } from "@opentui/solid"

export type DialogBtwProps = {
  sessionID: string
  question: string
  providerID: string
  modelID: string
}

export function DialogBtw(props: DialogBtwProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sdk = useSDK()
  const [text, setText] = createSignal("")
  const [done, setDone] = createSignal(false)
  const controller = new AbortController()

  dialog.setSize("large")

  useKeyboard((evt) => {
    if (evt.name === "escape" || evt.name === "return" || evt.name === "space") {
      controller.abort()
      dialog.clear()
    }
  })

  onCleanup(() => {
    controller.abort()
  })

  onMount(async () => {
    try {
      const res = await sdk.fetch(sdk.url + "/session/" + props.sessionID + "/btw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: props.question,
          providerID: props.providerID,
          modelID: props.modelID,
        }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        setText("Error: " + (res.statusText || "request failed"))
        setDone(true)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        setText((prev) => prev + decoder.decode(value, { stream: true }))
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setText((prev) => prev + "\n\nError: " + (err?.message || "unknown error"))
      }
    }
    setDone(true)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          btw
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{text() || "thinking..."}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <text fg={theme.textMuted}>{done() ? "space to dismiss" : "streaming..."}</text>
      </box>
    </box>
  )
}
