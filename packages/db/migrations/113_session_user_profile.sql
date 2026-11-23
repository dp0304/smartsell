CREATE FUNCTION ss.session_user_profile(p_token text)
RETURNS TABLE(id uuid, email text, name text, username text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.username
  FROM ss.sessions s JOIN ss.users u ON u.id = s.user_id
  WHERE s.token_hash = p_token AND s.expires_at > statement_timestamp();
$$;

REVOKE EXECUTE ON FUNCTION ss.session_user_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ss.session_user_profile(text) TO smartsell_request;
