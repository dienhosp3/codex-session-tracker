"""Double-click to delete the generated repository files and keep the result visible."""

from cleanup_repo import main


if __name__ == '__main__':
    exit_code = 0
    try:
        exit_code = main(['--delete'])
    except (OSError, ValueError, KeyError) as error:
        print(f'STOPPED: {error}')
        exit_code = 1
    finally:
        try:
            input('\nNhan Enter de dong cua so...')
        except EOFError:
            pass
    raise SystemExit(exit_code)
