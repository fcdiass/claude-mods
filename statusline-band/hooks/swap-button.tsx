// A stretch of the band that shows other text: `hover` swaps it while the pointer is over it
// (the folder to its full path, and a click posts `action`, which the hooks module copies);
// `click` swaps it on each click (the 5h/7d windows to the cost and back); `none` never swaps.

import type { ClientModule, JsonValue } from 'claude-code'

export type Part = { text: string; color?: string; bold?: boolean; dim?: boolean; underline?: boolean }
export type SwapButtonProps = { parts: Part[]; altParts: Part[]; trigger: 'hover' | 'click' | 'none'; action?: string }
type State = { isHovered: boolean; isPressed: boolean; isToggled: boolean }

const SwapButton: ClientModule<SwapButtonProps, State> = (props, surface) => {
  const { Text } = surface.elements
  const state = surface.state ?? { isHovered: false, isPressed: false, isToggled: false }

  surface.onPointer(event => {
    if (event.type === 'enter' || event.type === 'leave') {
      surface.setState({ ...state, isHovered: event.type === 'enter' })
      return
    }
    if ((event.button ?? 'left') !== 'left') return
    if (event.type === 'down') {
      surface.setState({ ...state, isPressed: true })
      return
    }
    // A press released over the text acts, as a button does; released elsewhere it is dropped.
    if (event.type === 'up' && state.isPressed) {
      const isInside = event.x >= 0 && event.y >= 0 && (surface.columns === 0 || (event.x < surface.columns && event.y < surface.rows))
      const isToggled = isInside && props.trigger === 'click' ? !state.isToggled : state.isToggled
      surface.setState({ ...state, isPressed: false, isToggled })
      if (isInside && props.action !== undefined) surface.post({ action: props.action } as JsonValue)
    }
  })

  const isAlt = props.trigger === 'hover' ? state.isHovered : state.isToggled
  const parts = isAlt ? props.altParts : props.parts
  return (
    <Text>
      {parts.map(part => (
        <Text color={part.color} bold={part.bold} dimColor={part.dim} underline={part.underline}>
          {part.text}
        </Text>
      ))}
    </Text>
  )
}

export default SwapButton
