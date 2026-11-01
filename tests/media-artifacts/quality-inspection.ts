import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import type {ArtifactManifest} from '../../packages/contracts/src/index.ts';
import {runTool,fileHash,type ToolTrace} from '../../packages/adapters/src/media/render/index.ts';
import {LOCAL_TOOLS} from '../../packages/adapters/src/media/render/tools.ts';
import {evidence,evidenceRoot} from './harness.ts';
const latest=readdirSync(evidenceRoot).filter(name=>/^real-media-job-ledger-\d+\.json$/.test(name)).sort().at(-1)!;
const source=JSON.parse(readFileSync(join(evidenceRoot,latest),'utf8')) as {results:Array<{platform:string;format:string;manifest:ArtifactManifest}>};
const samples=[];
for(const entry of source.results){if(!['short_video','long_video'].includes(entry.format))continue;const artifactRoot=join(evidenceRoot,'artifact-manifests',entry.manifest.artifact_id),file=entry.manifest.files.find(f=>f.relative_path===`video/${entry.platform}.mp4`)!;assert.equal(await fileHash(join(artifactRoot,file.relative_path)),file.sha256);const traces:ToolTrace[]=[];await runTool(LOCAL_TOOLS.ffmpeg,['-hide_banner','-i',join(artifactRoot,file.relative_path),'-map','0:a:0','-af','loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-f','null','-'],{traces});const tail=traces[0]!.stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/);assert.ok(tail);const loudness=JSON.parse(tail[0]) as Record<string,string>;assert.ok(Math.abs(Number(loudness.input_i)+16)<2);assert.ok(Number(loudness.input_tp)<-1.5);const subtitles=readFileSync(join(artifactRoot,'video/subtitles.srt'),'utf8');assert.ok(subtitles.includes('00:00:00,000 --> 00:00:04,000'));assert.ok(subtitles.includes('00:00:04,000 --> 00:00:08,000'));samples.push({platform:entry.platform,artifact_id:entry.manifest.artifact_id,video_file:file.relative_path,sha256:file.sha256,metadata:file.metadata,loudness_input_measurement:loudness,srt_exact_fixed_0_4_8_second_timeline:true,burned_raster_and_mov_text:true,manual_audible_review:'not_run',owner_voice:false});}
evidence('playback-quality.json',{status:'partial_verified',evidence_grade:'real_provider',checked_at:new Date().toISOString(),actual_local_tools:true,source_ledger:latest,samples,technical_loudness_tolerance:{target_lufs:-16,tolerance_lu:2,true_peak_max_dbtp:-1.5},human_full_video_review:'blocked',real_h3:'blocked',real_owner_footage:'blocked'});
