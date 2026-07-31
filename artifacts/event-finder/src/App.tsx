import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Layout } from "@/components/layout/Layout";
import Dashboard from "@/pages/dashboard";
import UrlLists from "@/pages/lists/index";
import UrlListDetail from "@/pages/lists/detail";
import RunHistory from "@/pages/runs/index";
import RunDetail from "@/pages/runs/detail";
import Results from "@/pages/results";
import PastEvents from "@/pages/past-events";
import Admin from "@/pages/admin";
import AutomationPage from "@/pages/automation";
import LoginPage from "@/pages/LoginPage";
import RequestAccessPage from "@/pages/RequestAccessPage";
import ActivatePage from "@/pages/ActivatePage";
import ForgotPasswordPage from "@/pages/ForgotPasswordPage";
import ResetPasswordPage from "@/pages/ResetPasswordPage";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedApp() {
  const { token } = useAuth();

  if (!token) {
    return <Redirect to="/login" />;
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/lists" component={UrlLists} />
        <Route path="/lists/:id" component={UrlListDetail} />
        <Route path="/runs" component={RunHistory} />
        <Route path="/runs/:id" component={RunDetail} />
        <Route path="/results" component={Results} />
        <Route path="/past-events" component={PastEvents} />
        <Route path="/automation" component={AutomationPage} />
        <Route path="/admin" component={Admin} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function AppRoutes() {
  const { token } = useAuth();

  return (
    <Switch>
      <Route path="/login">
        {token ? <Redirect to="/" /> : <LoginPage />}
      </Route>
      <Route path="/request-access">
        {token ? <Redirect to="/" /> : <RequestAccessPage />}
      </Route>
      <Route path="/activate" component={ActivatePage} />
      <Route path="/forgot-password">
        {token ? <Redirect to="/" /> : <ForgotPasswordPage />}
      </Route>
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route>
        <ProtectedApp />
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AuthProvider>
              <AppRoutes />
            </AuthProvider>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
