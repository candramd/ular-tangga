import type { Metadata } from "next";
import AdminApp from "@/components/AdminApp";
import "./admin.css";

export const metadata: Metadata = {
  title: "Panel Admin | Ular Tangga Adventure",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AdminApp />;
}