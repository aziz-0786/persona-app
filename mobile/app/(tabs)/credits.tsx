import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  FlatList,
  Linking,
  RefreshControl,
} from "react-native";
import { apiFetch } from "@/lib/api";
import { useGoogleAuth } from "@/lib/auth";
import type { CreditTransaction } from "@/lib/types";

const ACCENT = "#6C5FF6";

export default function CreditsScreen() {
  const { session } = useGoogleAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!session) {
      setLoading(false);
      return;
    }
    try {
      const [balanceData, historyData] = await Promise.all([
        apiFetch<{ balance: number }>("/api/credits/balance"),
        apiFetch<CreditTransaction[]>("/api/credits/history"),
      ]);
      setBalance(balanceData.balance);
      setTransactions(historyData);
    } catch (err) {
      console.error("[CREDITS] failed to load:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  function handleRefresh() {
    setRefreshing(true);
    load();
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={ACCENT} />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={transactions}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={ACCENT} />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.balanceLabel}>Credit balance</Text>
          <Text style={styles.balanceValue}>{balance?.toLocaleString() ?? "—"}</Text>
          <Pressable onPress={() => Linking.openURL("https://lyra.app/dashboard/credits")}>
            <Text style={styles.link}>Buy credits at lyra.app</Text>
          </Pressable>
          <Text style={styles.sectionTitle}>Recent Transactions</Text>
        </View>
      }
      ListEmptyComponent={<Text style={styles.emptyText}>No transactions yet.</Text>}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View>
            <Text style={styles.date}>{new Date(item.createdAt).toLocaleDateString()}</Text>
            <Text style={styles.meta}>{item.type}</Text>
          </View>
          <View style={styles.rowRight}>
            <Text style={[styles.credits, { color: item.credits < 0 ? "#F04438" : "#3DD68C" }]}>
              {item.credits > 0 ? "+" : ""}
              {item.credits}
            </Text>
            <Text style={styles.balanceAfter}>bal: {item.balanceAfter}</Text>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f" },
  center: { flex: 1, backgroundColor: "#0f0f0f", alignItems: "center", justifyContent: "center" },
  header: { alignItems: "center", paddingVertical: 32, paddingHorizontal: 20 },
  balanceLabel: { color: "#8080A0", fontSize: 14 },
  balanceValue: { color: "#F0F0F8", fontSize: 44, fontWeight: "700", marginTop: 4 },
  link: { color: ACCENT, fontSize: 14, marginTop: 12, fontWeight: "600" },
  sectionTitle: {
    color: "#8080A0",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    marginTop: 32,
    alignSelf: "flex-start",
  },
  emptyText: { color: "#8080A0", fontSize: 14, textAlign: "center", paddingVertical: 24 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#2A2845",
  },
  date: { color: "#F0F0F8", fontSize: 14, fontWeight: "600" },
  meta: { color: "#8080A0", fontSize: 12, marginTop: 2, textTransform: "capitalize" },
  rowRight: { alignItems: "flex-end" },
  credits: { fontSize: 15, fontWeight: "700" },
  balanceAfter: { color: "#8080A0", fontSize: 11, marginTop: 2 },
});
