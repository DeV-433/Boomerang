# Boomerang

An AI agent that finds PayPal revenue at risk, chooses a recovery action for each case, carries it out within strict policy limits, and reports the money it won back.

> Work in progress. This README will be expanded as the build progresses.

## Overview

- **Lanes:** overdue invoices and failed subscription payments
- **Loop:** detect → diagnose → propose → policy gate → execute → observe
- **Safety:** a deterministic policy gate vets every action; the model never calls PayPal directly
- **Proof:** an append-only, hash-chained audit log, plus recovered dollars measured against a control group

## Stack

TypeScript · Node + Fastify · Postgres (Drizzle) · React + Vite · AG Grid · Gemini API · PayPal Sandbox + Agent Toolkit · Render

## Status

Built and demonstrated against the **PayPal sandbox** only.

## Setup

Copy `.env.example` to `.env` and fill in the values. Full instructions coming soon.
