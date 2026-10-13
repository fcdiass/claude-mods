// A stretch of the band that shows other text: `hover` swaps it while the pointer is over it
// (the folder to its full path, and a click posts `action`, which the hooks module copies);
// `click` swaps it on each click (the context bar to its tokens and back); `none` never swaps.
// `isHoverInverse` inverts its colors under the pointer, as the model text does, to show it is clickable.
// `hotColumns` narrows the pointer and the click to the first columns of the first row (the
// folder's icon); a click on the rest posts `restAction` (the folder's menu), the rest inverted
// under the pointer, or nothing without one.

import type { ClientModule, JsonValue } from 'claude-code'

export type Part = { text: string; color?: string; bold?: boolean; dim?: boolean; underline?: boolean }
export type SwapButtonProps = {
  parts: Part[]
  altParts: Part[]
  trigger: 'hover' | 'click' | 'none'
  action?: string
  isHoverInverse?: boolean
  hotColumns?: number
  restAction?: string
}
type Zone = 'hot' | 'rest'
type State = { isHovered: boolean; isPressed: boolean; isToggled: boolean; restHovered?: boolean; pressedZone?: Zone }

const SwapButton: ClientModule<SwapButtonProps, State> = (props, surface) => {
  const { Text } = surface.elements
  const state = surface.state ?? { isHovered: false, isPressed: false, isToggled: false }

  const isWithin = (x: number, y: number) =>
    x >= 0 && y >= 0 && (surface.columns === 0 || (x < surface.columns && y < surface.rows))
  // Where a point falls: the hot columns, the rest (only with a rest action), or nowhere.
  const zoneAt = (x: number, y: number): Zone | undefined => {
    if (!isWithin(x, y)) return undefined
    if (props.hotColumns === undefined || (x < props.hotColumns && y === 0)) return 'hot'
    return props.restAction === undefined ? undefined : 'rest'
  }

  surface.onPointer(event => {
    if (event.type === 'enter' || event.type === 'leave' || (event.type === 'move' && event.button === undefined)) {
      const zone = event.type === 'leave' ? undefined : zoneAt(event.x, event.y)
      const isHovered = zone === 'hot'
      const restHovered = zone === 'rest'
      if (isHovered !== state.isHovered || restHovered !== (state.restHovered ?? false)) {
        surface.setState({ ...state, isHovered, restHovered })
      }
      return
    }
    if ((event.button ?? 'left') !== 'left') return
    if (event.type === 'down') {
      const zone = zoneAt(event.x, event.y)
      if (zone !== undefined) surface.setState({ ...state, isPressed: true, pressedZone: zone })
      return
    }
    // A press released where it began acts, as a button does; released elsewhere it is dropped.
    if (event.type === 'up' && state.isPressed) {
      const zone = zoneAt(event.x, event.y)
      const isInside = zone !== undefined && zone === (state.pressedZone ?? 'hot')
      const isToggled = isInside && zone === 'hot' && props.trigger === 'click' ? !state.isToggled : state.isToggled
      surface.setState({ ...state, isPressed: false, isToggled })
      const action = zone === 'rest' ? props.restAction : props.action
      if (isInside && action !== undefined) surface.post({ action } as JsonValue)
    }
  })

  const isAlt = props.trigger === 'hover' ? state.isHovered : state.isToggled
  const parts = isAlt ? props.altParts : props.parts
  const isInverse = props.isHoverInverse === true && state.isHovered
  // Under the pointer the rest inverts past its first part, the hot one.
  const isRestInverse = !isAlt && state.restHovered === true
  return (
    <Text>
      {parts.map((part, i) => (
        <Text
          color={part.color}
          bold={part.bold}
          dimColor={part.dim}
          underline={part.underline}
          inverse={isInverse || (isRestInverse && i > 0)}
        >
          {part.text}
        </Text>
      ))}
    </Text>
  )
}

export default SwapButton
