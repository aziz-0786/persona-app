import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

// #6C5FF6 is this app's actual brand accent (see ../../tailwind.config.ts
// `accent.DEFAULT` in the web project) — not the generic purple placeholder
// originally suggested for this task.
const ACCENT = "#6C5FF6";
const TAB_BAR_BG = "#0f0f0f";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ACCENT,
        tabBarInactiveTintColor: "#8080A0",
        tabBarStyle: { backgroundColor: TAB_BAR_BG, borderTopColor: "#2A2845" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="calls"
        options={{
          title: "Calls",
          tabBarIcon: ({ color, size }) => <Ionicons name="call" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="credits"
        options={{
          title: "Credits",
          tabBarIcon: ({ color, size }) => <Ionicons name="star" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <Ionicons name="settings" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
