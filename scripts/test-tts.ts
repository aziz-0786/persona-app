import { config } from "dotenv";
config();

async function main() {
  const testText = "Hey, good to hear from you.";

  const res = await fetch(
    `https://api.runpod.ai/v2/${process.env.RUNPOD_TTS_ENDPOINT_ID}/runsync`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RUNPOD_API_KEY}`,
      },
      body: JSON.stringify({
        input: {
          text: testText,
          exaggeration: 0.5,
          cfg_weight: 0.5,
          temperature: 0.8,
          // no voice_b64 — tests base voice only
        },
      }),
    }
  );

  const data = await res.json();
  console.log("Status:", res.status);
  console.log("Keys:", Object.keys(data));
  console.log("Output keys:", Object.keys(data.output ?? {}));
  console.log("audio_base64 length:", data.output?.audio_base64?.length ?? 0);
  if (data.error) console.log("Error:", data.error);
}

main();
