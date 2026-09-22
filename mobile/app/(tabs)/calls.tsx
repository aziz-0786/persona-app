import { useEffect, useState, useCallback } from "react";
import { View, Text, FlatList, StyleSheet, ActivityIndicator, RefreshControl } from "react-native";
import { apiFetch } from "@/lib/api";
import { useGoogleAuth } from "@/lib/auth";
import type { Call } from "@/lib/types";

const ACCENT = "#6C5FF6";

function formatDuration(seconds: number | null) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

const STATUS_COLORS: Record<string, string> = {
  completed: "#3DD68C",
  active: "#FFB020",
  failed: "#F04438",
};

export default function CallsScreen() {
  const { session } = useGoogleAuth();
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!session) {
      setLoading(false);
      return;
    }
    try {
      const data = await apiFetch<Call[]>("/api/calls/history");
      setCalls(data);
    } catch (err) {
      console.error("[CALLS] failed to load history:", err);
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
      data={calls}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={ACCENT} />
      }
      contentContainerStyle={calls.length === 0 ? styles.emptyContainer : undefined}
      ListEmptyComponent={
        <Text style={styles.emptyText}>No calls yet. Start your first call from Home.</Text>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowLeft}>
            <Text style={styles.date}>{new Date(item.startedAt).toLocaleString()}</Text>
            <Text style={styles.meta}>
              {formatDuration(item.durationSeconds)} · {item.creditsUsed} credits
            </Text>
          </View>
          <View
            style={[
              styles.badge,
              { backgroundColor: (STATUS_COLORS[item.status] ?? "#8080A0") + "22" },
            ]}
          >
            <Text style={[styles.badgeText, { color: STATUS_COLORS[item.status] ?? "#8080A0" }]}>
              {item.status}
            </Text>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f" },
  center: { flex: 1, backgroundColor: "#0f0f0f", alignItems: "center", justifyContent: "center" },
  emptyContainer: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { color: "#8080A0", fontSize: 14, textAlign: "center", paddingHorizontal: 32 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#2A2845",
  },
  rowLeft: { flex: 1 },
  date: { color: "#F0F0F8", fontSize: 14, fontWeight: "600" },
  meta: { color: "#8080A0", fontSize: 12, marginTop: 2 },
  badge: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
});
