// A label on the band that runs a slash command on click: "Opus 5.5 · medium" opens /model,
// "ctx" opens /context. A Button's label takes no color, so this surface module draws the text
// and posts the click to the hooks module, which runs the command.

import type { ClientModule } from 'claude-code'

export type CommandButtonProps = { label: string; command: string; color?: string; bold?: boolean }
type State = { isHovered: boolean; isPressed: boolean }

const CommandButton: ClientModule<CommandButtonProps, State> = (props, surface) => {
  const { Text } = surface.elements
  const state = surface.state ?? { isHovered: false, isPressed: false }

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
      surface.setState({ ...state, isPressed: false })
      if (isInside) surface.post({ open: props.command })
    }
  })

  // Under the pointer the colors invert: the label's color fills the cells, and the letters take
  // the terminal's own background, as if cut out of it.
  return (
    <Text color={props.color} bold={props.bold} inverse={state.isHovered}>
      {props.label}
    </Text>
  )
}

export default CommandButton
