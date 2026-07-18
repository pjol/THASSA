import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../lib/api";
import { bestImageUrl } from "../lib/media";
import { useSession } from "../lib/session";
import { space, useTheme } from "../lib/theme";
import { pageItems, type Paged, type StoryGroup } from "../lib/types";
import { Avatar, Skeleton } from "./ui";
import { VideoPlayer } from "./VideoPlayer";

// Stories rail atop the feed (rings dim once fully seen) + the full-screen
// viewer with per-story progress bars, tap-to-advance / tap-left-to-rewind and
// hold-to-pause, for both photos and videos.

// The viewer route reads the tapped rail state from this module-level holder
// (avoids serializing story groups through router params).
let viewerState: { groups: StoryGroup[]; index: number } | null = null;
export function getViewerState() {
  return viewerState;
}

export function StoriesRail() {
  const api = useApi();
  const t = useTheme();
  const router = useRouter();
  const { me } = useSession();
  const { data, isLoading } = useQuery({
    queryKey: ["stories"],
    queryFn: () => api.get<Paged<StoryGroup>>("/v1/stories"),
    staleTime: 60_000,
  });

  const groups = pageItems<StoryGroup>(data);

  // "Your story": open the full-screen in-app camera (Instagram-story style).
  // Stories are camera-only — the camera screen handles capture and upload
  // (media-id flow) and invalidates ["stories"] on send.
  const addStory = () => router.push("/story-camera" as never);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: space.md, paddingVertical: 10, gap: 14 }}
    >
      <Pressable onPress={addStory} style={{ alignItems: "center", gap: 4, width: 68 }}>
        <View>
          <Avatar url={me?.avatar_url} size={58} />
          <View
            style={{
              position: "absolute",
              bottom: -2,
              right: -2,
              backgroundColor: t.blue,
              width: 22,
              height: 22,
              borderRadius: 11,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 2,
              borderColor: t.bg,
            }}
          >
            <Ionicons name="add" size={14} color="#fff" />
          </View>
        </View>
        <Text style={{ color: t.textDim, fontSize: 11 }}>Your story</Text>
      </Pressable>
      {isLoading
        ? [0, 1, 2, 3].map((i) => <Skeleton key={i} style={{ width: 64, height: 84, borderRadius: 12 }} />)
        : groups.map((g, i) => (
            <Pressable
              key={g.user.id}
              onPress={() => {
                viewerState = { groups, index: i };
                router.push("/story-viewer" as never);
              }}
              style={{ alignItems: "center", gap: 4, width: 68 }}
            >
              <Avatar url={g.user.avatar_url} size={58} ring seen={g.all_viewed} />
              <Text style={{ color: t.textDim, fontSize: 11 }} numberOfLines={1}>
                {g.user.username}
              </Text>
            </Pressable>
          ))}
    </ScrollView>
  );
}

const PHOTO_MS = 5000;

export function StoryViewerScreen() {
  const t = useTheme();
  const api = useApi();
  const router = useRouter();
  const qc = useQueryClient();
  const { me } = useSession();
  const { width, height } = useWindowDimensions();
  const state = getViewerState();

  const [groupIdx, setGroupIdx] = useState(state?.index ?? 0);
  const [storyIdx, setStoryIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;
  const anim = useRef<Animated.CompositeAnimation | null>(null);

  const groups = state?.groups ?? [];
  const group = groups[groupIdx];
  const story = group?.stories[storyIdx];

  const close = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["stories"] });
    router.back();
  }, [qc, router]);

  const advance = useCallback(() => {
    if (!group) return;
    if (storyIdx + 1 < group.stories.length) setStoryIdx((i) => i + 1);
    else if (groupIdx + 1 < groups.length) {
      setGroupIdx((i) => i + 1);
      setStoryIdx(0);
    } else close();
  }, [group, storyIdx, groupIdx, groups.length, close]);

  const rewind = useCallback(() => {
    if (storyIdx > 0) setStoryIdx((i) => i - 1);
    else if (groupIdx > 0) {
      const prev = groups[groupIdx - 1];
      setGroupIdx((i) => i - 1);
      setStoryIdx(Math.max(0, prev.stories.length - 1));
    }
  }, [storyIdx, groupIdx, groups]);

  // Progress timer per story; videos use their duration, photos 5s.
  useEffect(() => {
    if (!story) return;
    // Mark viewed (fire and forget).
    api.post(`/v1/stories/${story.id}/view`).catch(() => {});
    progress.setValue(0);
    const ms = story.media.kind === "video" ? (story.media.duration_ms ?? 15000) : PHOTO_MS;
    anim.current = Animated.timing(progress, { toValue: 1, duration: ms, useNativeDriver: false });
    if (!paused) anim.current.start(({ finished }) => finished && advance());
    return () => anim.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  useEffect(() => {
    if (!story) return;
    if (paused) anim.current?.stop();
    else anim.current?.start(({ finished }) => finished && advance());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  if (!group || !story) {
    // Direct navigation without state — nothing to show.
    return (
      <View style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
        <Pressable onPress={close}>
          <Text style={{ color: "#fff" }}>Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      {story.media.kind === "video" ? (
        <VideoPlayer
          media={story.media}
          active={!paused}
          loop={false}
          style={{ width, height, position: "absolute" }}
          contentFit="contain"
        />
      ) : (
        <Image
          source={{ uri: bestImageUrl(story.media, width) }}
          style={{ width, height, position: "absolute" }}
          contentFit="contain"
        />
      )}

      {/* Tap zones: left third rewinds, right two-thirds advances; hold pauses. */}
      <Pressable
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: width / 3 }}
        onPress={rewind}
        onLongPress={() => setPaused(true)}
        onPressOut={() => setPaused(false)}
        delayLongPress={180}
      />
      <Pressable
        style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: (width * 2) / 3 }}
        onPress={advance}
        onLongPress={() => setPaused(true)}
        onPressOut={() => setPaused(false)}
        delayLongPress={180}
      />

      {/* Progress bars */}
      <View style={{ position: "absolute", top: 58, left: 10, right: 10, flexDirection: "row", gap: 4 }}>
        {group.stories.map((s, i) => (
          <View key={s.id} style={{ flex: 1, height: 2.5, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.35)", overflow: "hidden" }}>
            {i < storyIdx ? (
              <View style={{ flex: 1, backgroundColor: "#fff" }} />
            ) : i === storyIdx ? (
              <Animated.View
                style={{
                  height: "100%",
                  backgroundColor: "#fff",
                  width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
                }}
              />
            ) : null}
          </View>
        ))}
      </View>

      {/* Header */}
      <View style={{ position: "absolute", top: 68, left: 12, right: 12, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Avatar url={group.user.avatar_url} size={34} />
        <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
          {group.user.id === me?.id ? "Your story" : group.user.username}
        </Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={close} hitSlop={10}>
          <Ionicons name="close" size={28} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}
