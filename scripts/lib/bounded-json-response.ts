export type BoundedJsonRequestErrors = Readonly<{
  timeout: string;
  requestFailed: string;
  responseRejected: (status: number) => string;
  contentLengthInvalid: string;
  responseTooLarge: string;
  responseInvalid: string;
}>;

export async function fetchBoundedJson(input: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  maxResponseBytes: number;
  errors: BoundedJsonRequestErrors;
}): Promise<unknown> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)
    throw new Error("bounded_json_timeout_invalid");
  if (
    !Number.isSafeInteger(input.maxResponseBytes) ||
    input.maxResponseBytes < 1
  )
    throw new Error("bounded_json_byte_limit_invalid");

  const controller = new AbortController();
  let response: Response | undefined;
  let cancelBody: () => Promise<unknown> = async () =>
    await response?.body?.cancel();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      void cancelBody().catch(() => undefined);
      reject(new Error(input.errors.timeout));
    }, input.timeoutMs);
  });
  try {
    const operation = (async () => {
      response = await input.fetchImpl(input.url, {
        ...input.init,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.body) void response.body.cancel().catch(() => undefined);
        throw new Error(input.errors.responseRejected(response.status));
      }
      return readBoundedJson(
        response,
        input.maxResponseBytes,
        input.errors,
        (cancel) => {
          cancelBody = cancel;
        },
      );
    })();
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (timedOut)
      // Abort errors can include request URLs or authorization material.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(input.errors.timeout);
    if (
      error instanceof Error &&
      Object.values(input.errors).some(
        (value) => typeof value === "string" && error.message === value,
      )
    )
      throw error;
    if (
      error instanceof Error &&
      error.message === input.errors.responseRejected(response?.status ?? 0)
    )
      throw error;
    // Transport failures can include request URLs or authorization material.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(input.errors.requestFailed);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readBoundedJson(
  response: Response,
  maxResponseBytes: number,
  errors: BoundedJsonRequestErrors,
  registerCancel: (cancel: () => Promise<unknown>) => void,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      if (response.body) void response.body.cancel().catch(() => undefined);
      throw new Error(errors.contentLengthInvalid);
    }
    if (Number(contentLength) > maxResponseBytes) {
      if (response.body) void response.body.cancel().catch(() => undefined);
      throw new Error(errors.responseTooLarge);
    }
  }
  if (!response.body) throw new Error(errors.responseInvalid);

  const reader = response.body.getReader();
  registerCancel(async () => await reader.cancel());
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error(errors.responseTooLarge);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error(errors.responseInvalid);
  }
}
