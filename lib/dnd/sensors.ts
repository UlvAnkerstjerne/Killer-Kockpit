/**
 * lib/dnd/sensors.ts
 *
 * Smart DnD sensors for whole-row drag interactions.
 *
 * Both sensors skip drag activation when the pointer-down / touch-start event
 * originates from (or bubbles through) a native interactive element — button,
 * input, select, textarea, anchor, or any element with data-no-dnd="true".
 * All other row areas (title text, spacing, decorative icons) activate drag
 * normally.
 *
 * Usage:
 *   const sensors = useSensors(
 *     useSensor(SmartMouseSensor, { activationConstraint: { distance: 8 } }),
 *     useSensor(SmartTouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
 *   )
 */

import { MouseSensor, TouchSensor } from '@dnd-kit/core'
import type { MouseSensorOptions, TouchSensorOptions } from '@dnd-kit/core'
import type { MouseEvent, TouchEvent } from 'react'

/**
 * Walk up the DOM tree from `target`. Returns true if any ancestor
 * (up to the root) is a native interactive element or has data-no-dnd set.
 */
function isInteractiveElement(target: EventTarget | null): boolean {
  let el = target as HTMLElement | null
  while (el) {
    if (
      el.dataset?.noDnd ||
      ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(el.tagName) ||
      el.isContentEditable
    ) {
      return true
    }
    el = el.parentElement
  }
  return false
}

export class SmartMouseSensor extends MouseSensor {
  static activators: typeof MouseSensor.activators = [
    {
      eventName: 'onMouseDown',
      handler(event: MouseEvent, options: MouseSensorOptions): boolean {
        if (isInteractiveElement(event.nativeEvent.target)) return false
        return MouseSensor.activators[0].handler(event, options)
      },
    },
  ]
}

export class SmartTouchSensor extends TouchSensor {
  static activators: typeof TouchSensor.activators = [
    {
      eventName: 'onTouchStart',
      handler(event: TouchEvent, options: TouchSensorOptions): boolean {
        if (isInteractiveElement(event.nativeEvent.target)) return false
        return TouchSensor.activators[0].handler(event, options)
      },
    },
  ]
}
