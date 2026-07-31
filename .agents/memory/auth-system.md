---
name: Auth system
description: How authentication works end-to-end
---
- Server: bcryptjs passwords, jose JWT (8h), JWT_SECRET env var (Replit Secret).
- Public routes: /api/auth/* (register, login, activate, resend, me, change-password).
- Protected: all other /api/* routes behind requireAuth middleware in app.ts.
- User roles: "admin" and "viewer". Only @gofffinancial.com can self-register.
- Activation flow: admin creates user OR user self-registers → activation email → /activate?token=... → set password → JWT issued.
- Password reset flow mirrors activation: /auth/forgot-password (generic message, only emails activated users) → reset email → /reset-password?token=... → /auth/reset-password sets password, clears token, auto-logs-in (returns JWT). Dedicated users.reset_token (unique) + reset_token_expires_at cols; reset links live 1h (vs 7d activation).
- Frontend: AuthContext stores JWT in localStorage, decodes payload for user info. setAuthTokenGetter wires token into all API hooks.
- Admin user management: GET/POST/PATCH/DELETE /admin/users + POST /admin/users/:id/resend-invite.
**Why:** Client wanted invite-only access for their team.
**How to apply:** Any new API route goes into the protected router (routes/index.ts), not app.ts directly.
