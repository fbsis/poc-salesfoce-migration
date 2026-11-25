import { notFound } from 'next/navigation';
import { isAppError } from '@poc/core';

/**
 * `@poc/core` services throw `AppError('not_found')` for unknown ids. Detail
 * pages turn that into Next's 404 instead of a 500.
 */
export async function loadOrNotFound<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    if (isAppError(error) && error.code === 'not_found') notFound();
    throw error;
  }
}
