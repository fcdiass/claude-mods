// The band's "Opus 5.5 · medium", drawn in its own color and clickable: a Button's label takes
// no color, so this surface module draws the text and posts a click to the hooks module.

import type { ClientModule } from 'claude-code'

export type ModelButtonProps = { label: string; color: string }
type State = { isHovered: boolean; isPressed: boolean }

const ModelButton: ClientModule<ModelButtonProps, State> = (props, surface) => {
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
      if (isInside) surface.post({ open: 'model' })
    }
  })

  // Under the pointer the colors invert: the label's color fills the cells, and the letters take
  // the terminal's own background, as if cut out of it.
  return (
    <Text color={props.color} bold inverse={state.isHovered}>
      {props.label}
    </Text>
  )
}

export default ModelButton
