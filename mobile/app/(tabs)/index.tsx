import { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useGoogleAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";

const ACCENT = "#6C5FF6";

export default function HomeScreen() {
  const { session, isLoading, signIn } = useGoogleAuth();
  const router = useRouter();
  const [credits, setCredits] = useState<number | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoadingBalance(true);
    apiFetch<{ balance: number }>("/api/credits/balance")
      .then((data) => setCredits(data.balance))
      .catch((err) => console.error("[HOME] failed to load balance:", err))
      .finally(() => setLoadingBalance(false));
  }, [session]);

  function handleStartCall() {
    router.push("/call");
  }

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={ACCENT} />
      </View>
    );
  }

  if (!session) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Lyra.ai</Text>
        <Pressable style={styles.button} onPress={signIn}>
          <Text style={styles.buttonText}>Sign in to start</Text>
        </Pressable>
      </View>
    );
  }

  const noCredits = credits === 0;

  return (
    <View style={styles.container}>
      <View style={styles.balanceBlock}>
        <Text style={styles.balanceLabel}>Credit balance</Text>
        <Text style={styles.balanceValue}>
          {loadingBalance || credits === null ? "—" : credits.toLocaleString()}
        </Text>
      </View>

      <Pressable
        style={[styles.button, noCredits && styles.buttonDisabled]}
        onPress={handleStartCall}
        disabled={noCredits}
      >
        <Text style={styles.buttonText}>Start Call</Text>
      </Pressable>

      {noCredits && <Text style={styles.topupHint}>Top up credits at lyra.app</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f", padding: 24, justifyContent: "center" },
  center: {
    flex: 1,
    backgroundColor: "#0f0f0f",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  title: { color: "#F0F0F8", fontSize: 28, fontWeight: "700", marginBottom: 24 },
  balanceBlock: { alignItems: "center", marginBottom: 32 },
  balanceLabel: { color: "#8080A0", fontSize: 14 },
  balanceValue: { color: "#F0F0F8", fontSize: 40, fontWeight: "700", marginTop: 4 },
  button: {
    backgroundColor: ACCENT,
    borderRadius: 20,
    paddingVertical: 18,
    alignItems: "center",
    width: "100%",
  },
  buttonDisabled: { backgroundColor: "#2A2845" },
  buttonText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  topupHint: { color: "#8080A0", fontSize: 13, textAlign: "center", marginTop: 12 },
});
