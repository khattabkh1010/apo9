/**
 * Generates PLACEHOLDER demo media (short vertical clips + poster frames) with ffmpeg.
 * These are abstract motion graphics labelled "DEMO", not real food footage. Real content comes
 * from restaurants and creators through the upload + moderation flow.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

export interface DemoClip {
  key: string;
  label: string; // ASCII (ffmpeg drawtext has no Arabic shaping)
  colorA: string;
  colorB: string;
}

export function ffmpegAvailable(): boolean {
  return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

export function generateClip(dir: string, clip: DemoClip): { video: string; poster: string } | null {
  mkdirSync(dir, { recursive: true });
  const video = path.join(dir, `${clip.key}.mp4`);
  const poster = path.join(dir, `${clip.key}.jpg`);
  if (existsSync(video) && existsSync(poster)) return { video, poster };
  if (!ffmpegAvailable()) return null;
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const text = existsSync(font)
    ? `,drawtext=fontfile=${font}:text='${clip.label}':fontcolor=white@0.92:fontsize=46:x=(w-text_w)/2:y=h*0.62,` +
      `drawtext=fontfile=${font}:text='ABU9 DEMO CLIP':fontcolor=white@0.6:fontsize=22:x=(w-text_w)/2:y=h*0.62+70`
    : "";
  // Slowly rotating radial "plate" over a two-tone gradient, 6 s, 540x960, H.264.
  const filter =
    `[0]format=rgb24,geq=r='if(lt(hypot(X-W/2,Y-H*0.4),190+12*sin(T*2)),255*(0.55+0.45*sin(atan2(Y-H*0.4,X-W/2)*6+T*1.5)),r(X,Y))':` +
    `g='if(lt(hypot(X-W/2,Y-H*0.4),190+12*sin(T*2)),180*(0.6+0.4*sin(atan2(Y-H*0.4,X-W/2)*6+T*1.5)),g(X,Y))':` +
    `b='if(lt(hypot(X-W/2,Y-H*0.4),190+12*sin(T*2)),70*(0.5+0.5*sin(atan2(Y-H*0.4,X-W/2)*6+T*1.5)),b(X,Y))'${text},format=yuv420p`;
  const args = [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `gradients=s=540x960:c0=${clip.colorA}:c1=${clip.colorB}:d=6:speed=0.02:r=24`,
    "-filter_complex", filter,
    "-t", "6", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-movflags", "+faststart", "-an", video,
  ];
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (r.status !== 0) {
    console.warn(`ffmpeg failed for ${clip.key}: ${r.stderr?.slice(0, 300)}`);
    return null;
  }
  spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "2", "-i", video, "-frames:v", "1", "-q:v", "4", poster]);
  return { video, poster };
}
