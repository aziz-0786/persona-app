// Deepgram WebSocket client for mobile. React Native's WebSocket supports a
// third `{ headers }` constructor argument (confirmed directly in the
// installed RN 0.86 source — Libraries/WebSocket/WebSocket.js), so the
// Deepgram token goes in a real Authorization header rather than a query
// param (keeps it out of URLs that might get logged). TypeScript's global
// WebSocket type comes from the DOM lib (2-arg constructor only) — RN never
// ships its own override — so this local type documents the real runtime
// signature instead of reaching for `any`.
type RNWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> }
) => WebSocket;

export async function createDeepgramConnection(
  token: string,
  onTranscript: (text: string, isFinal: boolean) => void,
  onError: (err: Error) => void
): Promise<WebSocket> {
  const params = new URLSearchParams({
    model: "nova-3",
    language: "en",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
  });
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  return new Promise((resolve, reject) => {
    // TODO: remove before prod — never log the token itself.
    console.log("[DEEPGRAM] connecting...");

    const ws = new (WebSocket as unknown as RNWebSocketConstructor)(url, undefined, {
      headers: { Authorization: `Token ${token}` },
    });

    let opened = false;

    ws.onopen = () => {
      opened = true;
      resolve(ws);
    };

    ws.onerror = () => {
      const err = new Error("Deepgram WebSocket error");
      onError(err);
      if (!opened) reject(err);
    };

    ws.onclose = (event) => {
      // A clean caller-initiated close (see AudioRecorder/call screen
      // teardown) uses code 1000 — anything else mid-call is unexpected and
      // should surface as an error so the UI isn't left stuck silently.
      if (opened && event.code !== 1000) {
        onError(new Error(`Deepgram connection closed unexpectedly (${event.code})`));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        const transcript = msg?.channel?.alternatives?.[0]?.transcript;
        if (typeof transcript === "string" && transcript.length > 0) {
          onTranscript(transcript, !!msg.is_final);
        }
      } catch {
        // Non-JSON or unexpected message shape — ignore.
      }
    };
  });
}
