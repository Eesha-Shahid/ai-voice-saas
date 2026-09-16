"""Chatterbox TTS API - Text-to-speech with voice cloning on Modal."""

import os
from dotenv import load_dotenv
import modal

load_dotenv()

# Use this to test locally:
# modal run chatterbox_tts.py \
#   --prompt "Hello from Chatterbox [chuckle]." \
#   --voice-key "voices/system/<voice-id>"

# Use this to test CURL:
# curl -X POST "https://<your-modal-endpoint>/generate" \
#   -H "Content-Type: application/json" \
#   -H "X-Api-Key: <your-api-key>" \
#   -d '{"prompt": "Hello from Chatterbox [chuckle].", "voice_key": "voices/system/<voice-id>"}' \
#   --output output.wav

# --- R2 storage setup ---
# CloudBucketMount lets a Modal container "see" a Cloudflare R2 bucket
# as if it were a local folder, without downloading everything upfront.
# This replaces a Modal Volume, so voice audio files live in R2 instead.
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME")   
R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID")     
R2_MOUNT_PATH = "/r2"

r2_bucket = modal.CloudBucketMount(
  R2_BUCKET_NAME,
  bucket_endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
  secret=modal.Secret.from_name("cloudflare-r2"),  # R2 access keys, stored in Modal
  read_only=True,  # container can read voice files but never write/delete them
)

# --- Modal container image setup ---
# This defines the "operating system + packages" the remote container will run.
# uv_pip_install installs these packages fast, baked into the image at build time
# (so they don't need to be reinstalled on every function call).
image = modal.Image.debian_slim(python_version="3.10").uv_pip_install(
  "chatterbox-tts==0.1.6",       # the actual TTS model library
  "fastapi[standard]==0.124.4",  # web framework used to expose the /generate endpoint
  "peft==0.18.0",                # dependency needed by chatterbox-tts for model loading
)

# The Modal "App" is the top-level container for everything we deploy —
# functions, classes, secrets, etc. all get registered under this app name.
app = modal.App("chatterbox-tts", image=image)

# Anything inside `with image.imports():` is only imported when code actually
# runs INSIDE the remote container — not when this file is loaded locally.
# This keeps your local machine from needing torch/chatterbox/etc. installed
# just to define or deploy the app.
with image.imports():
    import io
    import os
    from pathlib import Path

    import torchaudio as ta
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    from fastapi import (
        Depends,
        FastAPI,
        HTTPException,
        Security,
    )
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import StreamingResponse
    from fastapi.security import APIKeyHeader
    from pydantic import BaseModel, Field

    # Defines that clients must send an "x-api-key" HTTP header to hit this API.
    api_key_scheme = APIKeyHeader(
      name="x-api-key",
      scheme_name="ApiKeyAuth",
      auto_error=False,  # don't auto-raise; we handle the error ourselves below
    )

    def verify_api_key(x_api_key: str | None = Security(api_key_scheme)):
      """FastAPI dependency: rejects requests with a missing/wrong API key.

      CHATTERBOX_API_KEY is expected to come from the 'chatterbox-api-key'
      Modal secret (injected as an environment variable inside the container).
      """
      expected = os.environ.get("CHATTERBOX_API_KEY", "")
      if not expected or x_api_key != expected:
        raise HTTPException(status_code=403, detail="Invalid API key")
      return x_api_key

    class TTSRequest(BaseModel):
      """Request model for text-to-speech generation.

      Pydantic validates incoming JSON against these types/constraints
      automatically — e.g. a request with temperature=5.0 gets rejected
      before your code ever runs, since le=2.0 caps it.
      """

      prompt: str = Field(..., min_length=1, max_length=5000)
      voice_key: str = Field(..., min_length=1, max_length=300)  # path to voice sample in R2
      temperature: float = Field(default=0.8, ge=0.0, le=2.0)
      top_p: float = Field(default=0.95, ge=0.0, le=1.0)
      top_k: int = Field(default=1000, ge=1, le=10000)
      repetition_penalty: float = Field(default=1.2, ge=1.0, le=2.0)
      norm_loudness: bool = Field(default=True)


# --- The main serverless class ---
# @app.cls turns this into a Modal-managed class: Modal spins up a container
# (with a GPU attached) to run its methods, and tears it down when idle.
@app.cls(
  gpu="a10g",               # request an NVIDIA A10G GPU for this container
  scaledown_window=60 * 5,  # Keep containers alive for 5 minutes after last request
  secrets=[
    # Each of these injects environment variables into the container
    # from secrets you created via `modal secret create ...` in the dashboard/CLI.
    modal.Secret.from_name("hf-token"),           # Hugging Face token, for model downloads
    modal.Secret.from_name("chatterbox-api-key"), # sets CHATTERBOX_API_KEY used above
    modal.Secret.from_name("cloudflare-r2"),      # R2 access keys for the bucket mount
  ],
  volumes={R2_MOUNT_PATH: r2_bucket},  # mount the R2 bucket at /r2 inside the container
)
@modal.concurrent(max_inputs=10)  # allow up to 10 requests to share one container instance
class Chatterbox:

  @modal.enter()
  def load_model(self):
    """Runs once when a new container starts up (not on every request).

    Loading the model here means it stays in GPU memory and is reused
    across many requests, instead of reloading it every single call.
    """
    self.model = ChatterboxTurboTTS.from_pretrained(device="cuda")

  @modal.asgi_app()
  def serve(self):
    """Exposes a FastAPI web app as a public HTTP endpoint via Modal.

    Whatever this method returns becomes the live API — Modal handles
    routing real HTTP requests into this container.
    """
    web_app = FastAPI(
      title="Chatterbox TTS API",
      description="Text-to-speech with voice cloning",
      docs_url="/docs",  # auto-generated interactive API docs at /docs
      dependencies=[Depends(verify_api_key)],  # every route requires a valid API key
    )

    web_app.add_middleware(
      CORSMiddleware,
      allow_origins=["*"],       # allow requests from any website/domain
      allow_credentials=True,
      allow_methods=["*"],
      allow_headers=["*"],
    )

    @web_app.post("/generate", responses={200: {"content": {"audio/wav": {}}}})
    def generate_speech(request: TTSRequest):
      """HTTP endpoint: POST /generate — turns text into speech audio."""

      # Look up the requested voice sample inside the mounted R2 bucket.
      voice_path = Path(R2_MOUNT_PATH) / request.voice_key
      if not voice_path.exists():
        raise HTTPException(
          status_code=400,
          detail=f"Voice not found at '{request.voice_key}'",
        )

      try:
        # .local(...) calls the `generate` method directly inside this SAME
        # container (no extra network hop), since we're already inside Modal.
        audio_bytes = self.generate.local(
          request.prompt,
          str(voice_path),
          request.temperature,
          request.top_p,
          request.top_k,
          request.repetition_penalty,
          request.norm_loudness,
        )
        # Stream the raw WAV bytes back as the HTTP response body.
        return StreamingResponse(
          io.BytesIO(audio_bytes),
          media_type="audio/wav",
        )
      except Exception as e:
        raise HTTPException(
          status_code=500,
          detail=f"Failed to generate audio: {e}",
        )

    return web_app

  @modal.method()
  def generate(
    self,
    prompt: str,
    audio_prompt_path: str,
    temperature: float = 0.8,
    top_p: float = 0.95,
    top_k: int = 1000,
    repetition_penalty: float = 1.2,
    norm_loudness: bool = True,
  ):
    """Runs the actual TTS model to produce speech audio.

    audio_prompt_path points to a sample voice recording, which the model
    uses to clone that voice's characteristics for the generated speech.
    Marked as a Modal @method so it can also be called remotely (see
    `.remote(...)` in the test entrypoint below) or locally within the class.
    """
    wav = self.model.generate(
      prompt,
      audio_prompt_path=audio_prompt_path,
      temperature=temperature,
      top_p=top_p,
      top_k=top_k,
      repetition_penalty=repetition_penalty,
      norm_loudness=norm_loudness,
    )

    # Encode the generated waveform into WAV format in memory (no temp file needed).
    buffer = io.BytesIO()
    ta.save(buffer, wav, self.model.sr, format="wav")
    buffer.seek(0)
    return buffer.read()


# --- Local test entrypoint ---
# This function runs on YOUR machine, not inside the Modal container.
# It's what executes when you run:  modal run chatterbox_tts.py [--flags]
@app.local_entrypoint()
def test(
  prompt: str = "Chatterbox running on Modal [chuckle].",
  voice_key: str = "voices/system/default.wav",
  output_path: str = "/tmp/chatterbox-tts/output.wav",
  temperature: float = 0.8,
  top_p: float = 0.95,
  top_k: int = 1000,
  repetition_penalty: float = 1.2,
  norm_loudness: bool = True,
):
  # Save the audio bytes to a file
  import pathlib

  # Creates a reference to the remote Chatterbox class — this does NOT
  # start a container yet; that happens on the first .remote() call below.
  chatterbox = Chatterbox()

  audio_prompt_path = f"{R2_MOUNT_PATH}/{voice_key}"

  # .remote(...) actually sends this call to run inside a Modal container
  # in the cloud (spinning one up if none is warm), and waits for the result.
  audio_bytes = chatterbox.generate.remote(
    prompt=prompt,
    audio_prompt_path=audio_prompt_path,
    temperature=temperature,
    top_p=top_p,
    top_k=top_k,
    repetition_penalty=repetition_penalty,
    norm_loudness=norm_loudness,
  )

  # Save the returned audio bytes to a local file so you can listen to it.
  output_file = pathlib.Path(output_path)
  output_file.parent.mkdir(parents=True, exist_ok=True)
  output_file.write_bytes(audio_bytes)
  print(f"Audio saved to {output_file}")