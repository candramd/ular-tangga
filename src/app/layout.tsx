import type { Metadata } from "next";
import "@fontsource/fredoka/500.css";
import "@fontsource/fredoka/600.css";
import "@fontsource/nunito-sans/400.css";
import "@fontsource/nunito-sans/600.css";
import "@fontsource/nunito-sans/700.css";
import "@fontsource/nunito-sans/800.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ular Tangga Adventure | Pengetahuan membuka jalan",
  description: "Jelajahi pulau, jawab tantangan, dan bermain ular tangga 3D bersama teman. Game edukasi multiplayer berbahasa Indonesia.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="id"><body>{children}</body></html>;
}
