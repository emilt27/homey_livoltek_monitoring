/**
 * True when the value went from at-or-above the threshold to below it
 */
export function crossedBelow(threshold: number, previous: number, current: number): boolean {
  return previous >= threshold && current < threshold;
}

/**
 * True when the value went from at-or-below the threshold to above it
 */
export function crossedAbove(threshold: number, previous: number, current: number): boolean {
  return previous <= threshold && current > threshold;
}
