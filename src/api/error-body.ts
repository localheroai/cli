export interface ApiErrorBody {
  code?: string;
  message?: string;
}

/**
 * The `error` object of a failed response, for the callers that use fetch
 * directly. A body that is missing or not JSON reads as no error details.
 */
export async function readErrorBody(response: Response): Promise<ApiErrorBody | undefined> {
  try {
    return (await response.json())?.error ?? undefined;
  } catch {
    return undefined;
  }
}
