"""Generate synthetic sample documents for testing."""

from __future__ import annotations

from pathlib import Path

# 10 realistic IT/security sample documents with overlapping terms
SAMPLE_DOCS: dict[str, str] = {
    "meeting_2024-01-15_security_review.txt": """\
Alright everyone, let's go through the quarterly security review. First up, we had three
critical vulnerabilities patched last month in our authentication service. The OAuth token
refresh flow had a race condition that could allow token reuse after expiration.

Sarah mentioned that the penetration test from CrowdStrike found two medium-severity XSS
issues in the admin dashboard. Those have been remediated and verified. We also updated our
WAF rules to block the new Log4j variant patterns.

Action items: rotate all API keys by end of week, schedule the next pen test for March,
and update the incident response runbook with the new escalation path. Dave will handle
the key rotation, and I'll coordinate with the SOC team on monitoring improvements.
""",
    "standup-2024-01-16-devops.txt": """\
Quick standup notes. Jenkins pipeline is failing intermittently on the integration tests.
Looks like a flaky test in the auth module — same OAuth token refresh test that's been
problematic. Mike is looking into it.

Container builds are now 40% faster after switching to multi-stage Docker builds. We also
migrated the staging environment to Kubernetes 1.28. No issues so far. Terraform configs
updated in the infra repo.

Blocked: still waiting on the new SSL certificates from the security team for the
staging load balancer. Dave said he'd have them by Thursday after the API key rotation
is complete.
""",
    "incident_2024-01-20_outage_postmortem.md": """\
# Incident Postmortem: January 20 Production Outage

## Timeline
- 14:32 UTC: Monitoring alerts fire for high error rate on API gateway
- 14:35 UTC: On-call engineer acknowledges alert
- 14:41 UTC: Root cause identified — database connection pool exhaustion
- 14:55 UTC: Connection pool limits increased, service recovering
- 15:10 UTC: Full recovery confirmed

## Root Cause
A deployment at 14:30 introduced a new database query in the user profile endpoint that
was missing connection cleanup in the error path. Under load, connections leaked until
the pool was exhausted. The query was part of the new caching layer for user preferences.

## Action Items
1. Add connection pool monitoring dashboards
2. Implement connection leak detection in CI pipeline
3. Review all database access patterns in the caching layer
4. Add circuit breaker for database connections
""",
    "training_session_kubernetes_basics.txt": """\
Welcome to the Kubernetes basics training. Today we'll cover pods, services, deployments,
and namespaces. This is targeted at developers who are new to container orchestration.

A pod is the smallest deployable unit in Kubernetes. It can contain one or more containers
that share storage and network resources. Most of the time you'll have one container per
pod, but sidecar patterns are common for logging and monitoring.

Services provide stable networking for pods. There are three main types: ClusterIP for
internal traffic, NodePort for external access on a specific port, and LoadBalancer which
provisions a cloud load balancer. We use ClusterIP for most internal microservices.

Deployments manage the desired state of your pods. You declare how many replicas you want,
what image to use, and Kubernetes ensures that state is maintained. Rolling updates let
you deploy new versions without downtime.

Namespaces provide logical isolation within a cluster. We use separate namespaces for
dev, staging, and production workloads. Resource quotas can be applied per namespace
to prevent any one team from consuming too many cluster resources.
""",
    "meeting_2024-02-01_api_design.txt": """\
API design review for the new notification service. We're going with REST for the public
API and gRPC for internal service-to-service communication.

Endpoints discussed:
- POST /api/v1/notifications — create a new notification
- GET /api/v1/notifications — list with pagination, filtering by status
- PATCH /api/v1/notifications/:id — update status (read, dismissed)
- DELETE /api/v1/notifications/:id — soft delete

Authentication will use the existing OAuth service with JWT bearer tokens. Rate limiting
set to 100 requests per minute per user. We'll add webhook support in v2.

Database: PostgreSQL with a separate notifications table. We discussed using Redis for
real-time delivery via pub/sub channels. The websocket gateway will subscribe to Redis
channels and push to connected clients.

Mike raised concerns about message ordering guarantees with Redis pub/sub. We agreed to
add sequence numbers and let the client handle reordering if needed.
""",
    "security_training_phishing_awareness.md": """\
# Phishing Awareness Training Notes

## Common Attack Vectors
- Email phishing: fake login pages, urgent action requests
- Spear phishing: targeted attacks using personal info from LinkedIn/social media
- Vishing: phone calls pretending to be IT support asking for credentials
- SMS phishing (smishing): text messages with malicious links

## Red Flags to Watch For
1. Sender email doesn't match the display name
2. Urgency or threats ("your account will be locked")
3. Requests for credentials or sensitive data
4. Suspicious attachments (.exe, .scr, macro-enabled docs)
5. URLs that look similar but aren't right (g00gle.com)

## What To Do
- Don't click links in suspicious emails
- Report to security@company.com
- Use the "Report Phishing" button in Outlook
- When in doubt, contact the sender through a known channel
- Never share your password or MFA codes with anyone

## Recent Stats
Last quarter we ran a simulated phishing campaign. 12% of employees clicked the link,
down from 23% the previous quarter. The security team will continue monthly simulations.
""",
    "interview_candidate_backend_engineer.txt": """\
Interview notes for backend engineer candidate — Jane Smith.

Technical assessment: Asked about designing a rate limiter for an API gateway. She
proposed a sliding window approach using Redis sorted sets with timestamps as scores.
Good understanding of trade-offs between fixed window, sliding window, and token bucket
algorithms. She correctly identified that fixed window can allow burst traffic at
window boundaries.

System design: Given a URL shortener problem. She started with requirements gathering,
estimated storage needs (assuming 100M URLs, about 5GB with metadata), chose base62
encoding for short codes. Discussed database sharding strategies and caching with Redis.
Mentioned using consistent hashing for distributed caching.

Coding: Implemented a LRU cache in Python using OrderedDict. Clean code, good edge case
handling. Asked clarifying questions about thread safety — added a threading.Lock for
concurrent access.

Culture fit: Strong communicator, asked good questions about team practices. Interested
in our observability stack (Prometheus, Grafana, OpenTelemetry).

Recommendation: Strong hire. Follow up on system design depth in next round.
""",
    "meeting_2024-02-10_database_migration.txt": """\
Database migration planning meeting. We're moving from MySQL 5.7 to PostgreSQL 16 for
the core application database.

Reasons for migration:
- Better JSON support for our document-heavy workloads
- PostGIS for the new location features
- Improved query planner and parallel query execution
- Better support for our Python stack (asyncpg, SQLAlchemy)

Migration strategy: dual-write approach. Phase 1: set up PostgreSQL replicas, run
pgloader for initial data sync. Phase 2: enable dual-writes to both databases.
Phase 3: switch reads to PostgreSQL, verify data consistency. Phase 4: decommission
MySQL.

Timeline: 6-week migration window. We need to update 47 database queries that use
MySQL-specific syntax. The ORM handles most of it, but there are 12 raw SQL queries
that need manual conversion.

Risk: the billing system has complex stored procedures in MySQL. Sarah suggested we
move those to application-level logic during the migration rather than porting the
procedures to PostgreSQL.

Dave will set up the PostgreSQL staging instance this week. Testing starts next Monday.
""",
    "weekly_retro_2024-02-14.txt": """\
Sprint retrospective — February 14, 2024.

What went well:
- Shipped the notification service MVP ahead of schedule
- Zero downtime deployment for the Kubernetes upgrade
- New monitoring dashboards caught a memory leak before it hit production
- Cross-team collaboration on the database migration planning was excellent

What could be improved:
- Code review turnaround time is still too long (averaging 2 days)
- Flaky tests in CI are wasting developer time — especially the OAuth tests
- Documentation for the new API endpoints is incomplete
- On-call handoffs need a better checklist

Action items:
1. Implement a code review SLA: initial review within 4 hours during business hours
2. Mike to create a task force to fix or quarantine flaky tests
3. Add API documentation to the definition of done
4. Sarah to draft an on-call handoff template

Team morale is good. People appreciated the incident postmortem culture — no blame,
just learning. Let's keep that up.
""",
    "notes_firewall_rule_changes_2024.txt": """\
Firewall rule change log — January through February 2024.

Jan 5: Opened port 8443 for the new API gateway in the DMZ. Approved by security team.
Rule: allow TCP 8443 from 10.0.0.0/8 to 192.168.1.50.

Jan 12: Blocked outbound traffic to known C2 servers. Updated threat intel feed from
AlienVault OTX. Added 847 new IP addresses to the blocklist.

Jan 20: Emergency rule during outage — temporarily allowed all traffic from monitoring
subnet to database tier for debugging. Rule removed Jan 21 after postmortem.

Feb 1: Updated WAF rules for the notification service API endpoints. Added rate limiting
at the firewall level as defense in depth alongside application-level rate limiting.

Feb 8: Quarterly review of all firewall rules. Removed 23 stale rules for decommissioned
services. Tightened SSH access to bastion hosts only (was previously open from office
subnet).

Feb 14: Added rules for PostgreSQL staging instance. Allow TCP 5432 from application
subnet and DevOps jump box only. Deny all other access to port 5432.
""",
}


def generate_sample_data(output_dir: Path) -> list[Path]:
    """Write synthetic sample documents and return their paths."""
    output_dir.mkdir(parents=True, exist_ok=True)
    created: list[Path] = []
    for filename, content in SAMPLE_DOCS.items():
        filepath = output_dir / filename
        filepath.write_text(content, encoding="utf-8")
        created.append(filepath)
    return created
