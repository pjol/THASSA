import { ActivityIndicator, View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button, space } from "./ui";
import { Theme, useTheme, useThemedStyles } from "../lib/theme";

const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:8080";

// Inline spinner for first-load of a list/screen.
export function Loading({ label }: { label?: string }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.center}>
      <ActivityIndicator color={theme.blue} size="large" />
      {label ? <Text style={styles.dim}>{label}</Text> : null}
    </View>
  );
}

// Inline error with retry, for a failed fetch.
export function ErrorState({
  onRetry,
  title = "Something went wrong",
  subtitle = "Please try again.",
}: {
  onRetry?: () => void;
  title?: string;
  subtitle?: string;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.center}>
      <Ionicons name="cloud-offline-outline" size={44} color={theme.textDim} />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.dim}>{subtitle}</Text>
      {onRetry ? (
        <Button title="Retry" variant="subtle" onPress={onRetry} style={{ marginTop: space.md, paddingHorizontal: 28 }} />
      ) : null}
    </View>
  );
}

// Inline empty state for a successful-but-empty list.
export function EmptyState({
  icon = "file-tray-outline",
  title,
  subtitle,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
}) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.center}>
      <Ionicons name={icon} size={44} color={theme.textDim} />
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.dim}>{subtitle}</Text> : null}
    </View>
  );
}

// Full-screen: backend unreachable.
export function ConnectionError({ onRetry }: { onRetry: () => void }) {
  const theme = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.screen}>
      <View style={styles.iconBadge}>
        <Ionicons name="cloud-offline-outline" size={36} color={theme.blue} />
      </View>
      <Text style={styles.h1}>Can't reach the server</Text>
      <Text style={styles.body}>
        We couldn't connect to Thassa. Check your internet connection and try again.
      </Text>
      <Button title="Try again" onPress={onRetry} style={{ marginTop: space.lg, paddingHorizontal: 40 }} />
      {__DEV__ && (
        <Text style={styles.devHint}>
          Dev: this device is calling{"\n"}
          {API_URL}
          {"\n"}On a physical phone, set EXPO_PUBLIC_API_URL to your computer's LAN IP (not localhost).
        </Text>
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.sm, minHeight: 240 },
    screen: { flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", padding: space.xl },
    iconBadge: {
      width: 76,
      height: 76,
      borderRadius: 38,
      backgroundColor: theme.blueTint,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: space.lg,
    },
    h1: { color: theme.text, fontSize: 22, fontWeight: "800", textAlign: "center" },
    body: { color: theme.textDim, fontSize: 16, textAlign: "center", lineHeight: 23, marginTop: space.sm, maxWidth: 340 },
    title: { color: theme.text, fontSize: 16, fontWeight: "700", marginTop: space.sm },
    dim: { color: theme.textDim, textAlign: "center" },
    devHint: { color: theme.textDim, fontSize: 11, textAlign: "center", marginTop: space.xl, lineHeight: 16 },
  });
