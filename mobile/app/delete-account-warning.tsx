import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";

export default function DeleteAccountWarningScreen() {
  const router = useRouter();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Delete your account</Text>
      <Text style={styles.body}>
        Account deletion isn&apos;t available in the mobile app yet. To delete your account,
        visit lyra.app/settings from a web browser.
      </Text>
      <Pressable style={styles.button} onPress={() => router.back()}>
        <Text style={styles.buttonText}>Go back</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f0f", padding: 24, justifyContent: "center", gap: 16 },
  title: { color: "#F0F0F8", fontSize: 22, fontWeight: "700", textAlign: "center" },
  body: { color: "#8080A0", fontSize: 14, textAlign: "center", lineHeight: 20 },
  button: {
    backgroundColor: "#1E1E32",
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 12,
  },
  buttonText: { color: "#F0F0F8", fontSize: 15, fontWeight: "600" },
});
