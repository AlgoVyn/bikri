/** The element that opened the peek; focus returns there when the peek closes. */
let trigger: HTMLElement | null = null;

export function rememberPeekTrigger(): void {
  trigger =
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
}

export function restorePeekFocus(): void {
  const element = trigger;
  trigger = null;
  if (element === null || !element.isConnected) return;
  requestAnimationFrame(() => {
    if (element.isConnected) element.focus({ preventScroll: true });
  });
}
