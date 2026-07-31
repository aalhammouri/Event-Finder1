import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  LayoutDashboard,
  Upload,
  Search,
  Settings,
  Menu,
  LogOut,
  Clock,
  History,
  Bot,
} from "lucide-react";
import { useState } from "react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useAuth } from "@/context/AuthContext";
import { useLocation as useWouterLocation } from "wouter";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/lists", label: "Import Data", icon: Upload },
  { href: "/results", label: "Results", icon: Search },
  { href: "/past-events", label: "Past Events", icon: History },
  { href: "/automation", label: "Automation", icon: Clock },
  { href: "/admin", label: "Admin Panel", icon: Settings },
];

function AppHeader() {
  return (
    <div className="border-b border-sidebar-border/50 shrink-0 flex items-center gap-3 px-5 py-4">
      <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
        <Bot className="w-4.5 h-4.5 text-primary-foreground w-[18px] h-[18px]" />
      </div>
      <div>
        <p className="text-sm font-bold text-sidebar-foreground leading-tight">Web Crawler</p>
        <p className="text-[11px] text-sidebar-foreground/55 leading-tight tracking-wide">by Goff Financial</p>
      </div>
    </div>
  );
}

function NavLinks({ className, onClick }: { className?: string; onClick?: () => void }) {
  const [location] = useLocation();

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {NAV_ITEMS.map((item) => {
        const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClick}
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <item.icon className="w-4 h-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

function UserBadge({ onClick }: { onClick?: () => void }) {
  const { user, logout } = useAuth();
  const [, setLocation] = useWouterLocation();

  const handleLogout = () => {
    logout();
    setLocation("/login");
    onClick?.();
  };

  const handleAccountClick = () => {
    setLocation("/admin?section=account");
    onClick?.();
  };

  if (!user) return null;

  return (
    <div className="border-t border-sidebar-border/50 p-3 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <button
          onClick={handleAccountClick}
          title="My account"
          className="w-8 h-8 rounded-full bg-sidebar-accent flex items-center justify-center text-sidebar-accent-foreground text-xs font-bold shrink-0 hover:opacity-80 transition-opacity"
        >
          {user.name.charAt(0).toUpperCase()}
        </button>
        <button
          onClick={handleAccountClick}
          title="My account"
          className="flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
        >
          <p className="text-xs font-medium text-sidebar-foreground truncate">{user.name}</p>
          <p className="text-xs text-sidebar-foreground/60 truncate">{user.email}</p>
        </button>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent h-7 w-7"
          onClick={handleLogout}
          title="Sign out"
        >
          <LogOut className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <div className="hidden md:flex flex-col w-64 bg-sidebar text-sidebar-foreground min-h-screen border-r border-sidebar-border shrink-0">
      <AppHeader />
      <div className="p-4 flex-1 overflow-y-auto">
        <NavLinks />
      </div>
      <UserBadge />
    </div>
  );
}

export function MobileHeader() {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden flex items-center h-14 px-4 bg-sidebar text-sidebar-foreground border-b border-sidebar-border/50 shrink-0">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="mr-3 text-sidebar-foreground hover:bg-sidebar-accent">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0 bg-sidebar text-sidebar-foreground border-sidebar-border flex flex-col">
          <AppHeader />
          <div className="p-4 flex-1">
            <NavLinks onClick={() => setOpen(false)} />
          </div>
          <UserBadge onClick={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
          <Bot className="w-4 h-4 text-primary-foreground" />
        </div>
        <span className="font-semibold text-base">Web Crawler</span>
      </div>
    </div>
  );
}
