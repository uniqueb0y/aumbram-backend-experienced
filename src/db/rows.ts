/** Small helpers for mapping pg rows. */
export function ms(value: Date): number {
  return value.getTime();
}

export function msOrNull(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

export function iso(msValue: number): string {
  return new Date(msValue).toISOString();
}