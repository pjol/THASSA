import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { FollowList } from "../../../components/FollowList";
import { Segmented } from "../../../components/ui";
import { useTheme } from "../../../lib/theme";

// Followers / Following list screen (spec §7d.3). Reached by tapping the
// Followers or Following count on a profile; a segmented control toggles between
// the two lists (IG-style), seeded by the `tab` param.
export default function Connections() {
  const { username, tab } = useLocalSearchParams<{ username: string; tab?: string }>();
  const t = useTheme();
  const navigation = useNavigation();
  const [active, setActive] = useState<"Followers" | "Following">(
    tab === "following" ? "Following" : "Followers"
  );

  useEffect(() => {
    navigation.setOptions({ title: username ? `@${username}` : "People" });
  }, [navigation, username]);

  if (!username) return <View style={{ flex: 1, backgroundColor: t.bg }} />;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Segmented
        options={["Followers", "Following"]}
        value={active}
        onChange={(v) => setActive(v as "Followers" | "Following")}
      />
      <FollowList username={username} kind={active === "Followers" ? "followers" : "following"} />
    </View>
  );
}
