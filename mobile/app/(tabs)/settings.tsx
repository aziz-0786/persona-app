import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { useGoogleAuth } from "@/lib/auth";

export default function SettingsScreen() {
  const { session, signOut } = useGoogleAuth();
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.profile}>
        <Text style={styles.name}>{session?.user.name ?? "—"}</Text>
        <Text style={styles.email}>{session?.user.email ?? "—"}</Text>
        {session?.user.role && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{session.user.role}</Text>
          </View>
        )}
      </View>

      <Pressable style={styles.button} onPress={() => signOut()}>
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>

      <Pressable style={styles.dangerButton} onPress={() => router.push("/delete-account-warning")}>
        <Text style={styles.dangerButtonText}>Delete account</Text>
      </Pressable>

      <Text style={styles.version}>Version {Constants.expoConfig?.version ?? "—"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f", padding: 24, paddingTop: 48 },
  profile: { alignItems: "center", marginBottom: 40 },
  name: { color: "#F0F0F8", fontSize: 20, fontWeight: "700" },
  email: { color: "#8080A0", fontSize: 14, marginTop: 4 },
  badge: {
    marginTop: 10,
    backgroundColor: "#1E1E32",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: { color: "#6C5FF6", fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
  button: {
    backgroundColor: "#1E1E32",
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 12,
  },
  buttonText: { color: "#F0F0F8", fontSize: 15, fontWeight: "600" },
  dangerButton: {
    backgroundColor: "rgba(240, 68, 56, 0.1)",
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(240, 68, 56, 0.3)",
  },
  dangerButtonText: { color: "#F04438", fontSize: 15, fontWeight: "600" },
  version: { color: "#404055", fontSize: 12, textAlign: "center", marginTop: "auto" },
});
