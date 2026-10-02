--
-- PostgreSQL database dump
--
\restrict abc123
SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE TYPE public.order_status AS ENUM (
    'PENDING',
    'PAID',
    'in progress'
);
CREATE FUNCTION public.touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now(); RETURN NEW;
END;
$$;
CREATE TABLE public.users (
    id bigint NOT NULL,
    email character varying(255) NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.users OWNER TO app;
CREATE SEQUENCE public.users_id_seq START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER TABLE public.users_id_seq OWNER TO app;
CREATE TABLE public.orders (
    id bigint NOT NULL,
    user_id bigint,
    status public.order_status DEFAULT 'PENDING'::public.order_status NOT NULL,
    kind character varying(16) NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    deleted_at timestamp without time zone,
    CONSTRAINT orders_kind_check CHECK (((kind)::text = ANY ((ARRAY['ONLINE'::character varying, 'STORE'::character varying])::text[]))),
    CONSTRAINT orders_total_check CHECK ((total >= (0)::numeric))
);
CREATE TABLE public.order_items (
    order_id bigint NOT NULL,
    line integer NOT NULL,
    shop_id bigint,
    sku text
);
CREATE MATERIALIZED VIEW public.order_totals AS SELECT 1 AS x WITH NO DATA;
COPY public.users (id, email, tags, created_at) FROM stdin;
1	a@b.c	{x;'y}	2020-01-01
\.
ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (order_id, line);
CREATE INDEX orders_user_id_idx ON public.orders USING btree (user_id);
CREATE UNIQUE INDEX orders_one_open ON public.orders USING btree (user_id) WHERE (deleted_at IS NULL);
CREATE INDEX users_lower_email ON public.users USING btree (lower((email)::text));
CREATE INDEX order_totals_x ON public.order_totals USING btree (x);
CREATE TRIGGER touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch();
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_shop_sku_fkey FOREIGN KEY (shop_id, sku) REFERENCES public.shop_items(shop_id, sku);
COMMENT ON TABLE public.orders IS 'Customer orders';
COMMENT ON COLUMN public.orders.user_id IS 'Who placed it
(may be empty)';
\unrestrict abc123
