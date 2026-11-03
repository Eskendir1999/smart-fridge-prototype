-- Emergency pause: prevents new RPC writes; does not delete or restore any user data.
update sf_private.stock_release_control set enabled=false where singleton;
-- Resume after investigation only:
-- update sf_private.stock_release_control set enabled=true where singleton;
