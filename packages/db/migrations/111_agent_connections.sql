-- An Agent connection owns a separate long-lived session. Browser logout and re-login never touch it;
-- revocation, expiry and membership removal (which deletes the member's sessions) end it.
CREATE FUNCTION ss.issue_session_ttl(p_token text, p_user uuid, p_seconds integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_seconds IS NULL OR p_seconds < 60 OR p_seconds > 365 * 86400 THEN
    RAISE EXCEPTION 'Session lifetime is out of range' USING ERRCODE = '22023';
  END IF;
  DELETE FROM ss.sessions WHERE token_hash IN (
    SELECT token_hash FROM ss.sessions WHERE expires_at <= statement_timestamp()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
  );
  INSERT INTO ss.sessions VALUES (p_token, p_user, statement_timestamp() + make_interval(secs => p_seconds));
END;
$$;

REVOKE EXECUTE ON FUNCTION ss.issue_session_ttl(text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ss.issue_session_ttl(text,uuid,integer) TO smartsell_request;
