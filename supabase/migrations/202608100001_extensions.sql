-- Travel Brain v0.1 extensions
create schema if not exists extensions;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists postgis with schema extensions;
