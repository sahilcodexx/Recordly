import React, { useMemo } from "react";
import type { SourceAudioTrackSettings } from "@/components/video-editor/audio/audioTypes";
import { resolveSourceTrackRoutingPolicy } from "@/lib/exporter/sourceTrackRoutingPolicy";
import type {
	AudioRegion,
	ClipRegion,
	SpeedRegion,
} from "../types";
import { getActiveClipIdAtSourceTime, isClipMutedById } from "./clipAudio";
import { useAudioPreviewSync } from "./useAudioPreviewSync";
import { useClipAudioSettingsController } from "./useClipAudioSettingsController";
import { useSourceAudioFallback } from "./useSourceAudioFallback";

function extractLocalPathFromMediaServerUrl(input: string | null | undefined): string | null {
	if (!input) return null;
	try {
		const url = new URL(input);
		const isLocalMediaServer =
			(url.protocol === "http:" || url.protocol === "https:") &&
			(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
			url.pathname === "/video";
		if (!isLocalMediaServer) return null;
		return url.searchParams.get("path");
	} catch {
		return null;
	}
}

interface UseVideoEditorAudioParams {
	currentSourcePath: string | null;
	selectedClipId: string | null;
	clipRegions: ClipRegion[];
	audioRegions: AudioRegion[];
	effectiveSpeedRegions: SpeedRegion[];
	sourceAudioTrackSettingsByClip: Record<string, SourceAudioTrackSettings>;
	setSourceAudioTrackSettingsByClip: React.Dispatch<
		React.SetStateAction<Record<string, SourceAudioTrackSettings>>
	>;
	defaultSourceAudioTrackSettings: SourceAudioTrackSettings;
	setDefaultSourceAudioTrackSettings: React.Dispatch<
		React.SetStateAction<SourceAudioTrackSettings>
	>;
	currentTime: number;
	timelineTime: number;
	duration: number;
	isPlaying: boolean;
	previewVolume: number;
	sourceAudioFallbackRefreshKey?: number;
	summarizeErrorMessage: (message: string) => string;
	onSourceFallbackLoadError: (error: unknown) => void;
	// User-controlled override of the per-source-audio-path start delay
	// (set by dragging the source-audio item in the timeline). When a path
	// is present in this map, the override replaces the value returned by
	// the main process's `getVideoAudioFallbackPaths` for the preview and
	// the export.
	sourceAudioStartOffsetOverrideMsByPath?: Record<string, number>;
	// User-controlled override of the per-source-audio-path trim from the
	// start of the audio (set by dragging the left edge of the
	// source-audio item in the timeline). Subtracted from the effective
	// start delay for the preview, and applied as an FFmpeg `atrim`
	// filter in the export.
	sourceAudioTrimStartOverrideMsByPath?: Record<string, number>;
}

export function useVideoEditorAudio({
	currentSourcePath,
	selectedClipId,
	clipRegions,
	audioRegions,
	effectiveSpeedRegions,
	sourceAudioTrackSettingsByClip,
	setSourceAudioTrackSettingsByClip,
	defaultSourceAudioTrackSettings,
	setDefaultSourceAudioTrackSettings,
	currentTime,
	timelineTime,
	duration,
	isPlaying,
	previewVolume,
	sourceAudioFallbackRefreshKey = 0,
	summarizeErrorMessage,
	onSourceFallbackLoadError,
	sourceAudioStartOffsetOverrideMsByPath,
	sourceAudioTrimStartOverrideMsByPath,
}: UseVideoEditorAudioParams) {
	const fallbackLookupSourcePath = useMemo(
		() => extractLocalPathFromMediaServerUrl(currentSourcePath) ?? currentSourcePath,
		[currentSourcePath],
	);

	const { sourceAudioFallbackPaths, sourceAudioFallbackStartDelayMsByPath } =
		useSourceAudioFallback({
			currentSourcePath: fallbackLookupSourcePath,
			refreshKey: sourceAudioFallbackRefreshKey,
			summarizeErrorMessage,
		});

	// Effective per-path delay = user override (if set) || main-process default.
	// The preview and the export should both read this so dragging the
	// source-audio item in the timeline takes effect everywhere.
	const effectiveSourceAudioStartDelayMsByPath = useMemo(() => {
		const merged: Record<string, number> = { ...sourceAudioFallbackStartDelayMsByPath };
		if (sourceAudioStartOffsetOverrideMsByPath) {
			for (const [path, delayMs] of Object.entries(sourceAudioStartOffsetOverrideMsByPath)) {
				if (Number.isFinite(delayMs)) {
					merged[path] = delayMs;
				}
			}
		}
		// Subtract any user-controlled trim. The trim removes the first
		// N ms of the audio file, so the audio that remains is N ms
		// shorter at the start. The effective start delay is reduced by
		// the trim so the audible content lines up with the video.
		if (sourceAudioTrimStartOverrideMsByPath) {
			for (const [path, trimMs] of Object.entries(sourceAudioTrimStartOverrideMsByPath)) {
				if (Number.isFinite(trimMs) && trimMs > 0) {
					const current = merged[path] ?? 0;
					merged[path] = Math.max(0, current - trimMs);
				}
			}
		}
		return merged;
	}, [
		sourceAudioFallbackStartDelayMsByPath,
		sourceAudioStartOffsetOverrideMsByPath,
		sourceAudioTrimStartOverrideMsByPath,
	]);

	// Effective per-path trim from the start of the audio file (in ms).
	// Applied by the export as an FFmpeg `atrim=start=<seconds>` filter
	// so the audio file is physically shortened (not just delayed).
	const effectiveSourceAudioTrimStartMsByPath = useMemo(() => {
		const out: Record<string, number> = {};
		if (sourceAudioTrimStartOverrideMsByPath) {
			for (const [path, trimMs] of Object.entries(sourceAudioTrimStartOverrideMsByPath)) {
				if (Number.isFinite(trimMs) && trimMs > 0) {
					out[path] = Math.round(trimMs);
				}
			}
		}
		return out;
	}, [sourceAudioTrimStartOverrideMsByPath]);

	const sourceTrackRoutingPolicy = useMemo(
		() => resolveSourceTrackRoutingPolicy(currentSourcePath, sourceAudioFallbackPaths),
		[currentSourcePath, sourceAudioFallbackPaths],
	);
	const previewSourceAudioFallbackPaths = sourceTrackRoutingPolicy.playbackPaths;
	const shouldMutePreviewVideo = sourceTrackRoutingPolicy.muteEmbeddedPreview;

	const activeClipIdAtCurrentTime = useMemo(
		() => getActiveClipIdAtSourceTime(currentTime, clipRegions),
		[clipRegions, currentTime],
	);
	const isCurrentClipMuted = useMemo(
		() => isClipMutedById(activeClipIdAtCurrentTime, clipRegions),
		[activeClipIdAtCurrentTime, clipRegions],
	);

	const {
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
	} = useClipAudioSettingsController({
		selectedClipId,
		activeClipId: activeClipIdAtCurrentTime,
		sourceAudioTrackSettingsByClip,
		setSourceAudioTrackSettingsByClip,
		defaultSourceAudioTrackSettings,
		setDefaultSourceAudioTrackSettings,
	});

	const { playSourceAudioPreview } = useAudioPreviewSync({
		audioRegions,
		previewVolume,
		isPlaying,
		currentTime,
		timelineTime,
		duration,
		effectiveSpeedRegions,
		previewSourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath: effectiveSourceAudioStartDelayMsByPath,
		sourceAudioResourceVersion: sourceAudioFallbackRefreshKey,
		isCurrentClipMuted,
		getSourceTrackPreviewGain,
		onSourceFallbackLoadError,
	});

	return {
		sourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		effectiveSourceAudioStartDelayMsByPath,
		effectiveSourceAudioTrimStartMsByPath,
		previewSourceAudioFallbackPaths,
		shouldMutePreviewVideo,
		activeClipIdAtCurrentTime,
		isCurrentClipMuted,
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		playSourceAudioPreview,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
	};
}
