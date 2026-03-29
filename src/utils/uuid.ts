import { randomUUID } from 'crypto';

export function generateId(): string {
  return randomUUID();
}
